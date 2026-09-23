const { badRequest } = require('./errors');

// 计费口径（本项目现有实现）
// 1. 计费重量 = max(实际重量, 体积重量)，体积重量 = 体积(m³) × 1000000 ÷ 体积系数，结果向上取到 0.5kg
// 2A. 首重续重（legacy）：首重以内收首重价，超出部分按续重单位向上进位，每个单位收续重价
// 2B. 阶梯价（tiered）：按计费重量落在的重量区间收费，区间为 [下界, 上界) 左闭右开，
//     边界重量（如 5kg）归上一个区间；区间内可登记「单价」（计费重量 × 单价）或「整段价」（一口价）
// 3. 两种算法的运费都不低于最低收费
// 4. 附加费 = 偏远附加（按分区）+ 超规附加（计费重量超限或件数超限）+ 保价费（保价金额 × 费率）
// 5. 月结客户按折扣作用于运费与附加费合计，现结客户不打折；费用以元为单位，保留两位
// 6. 当前生效算法记在 settings.pricingAlgorithm；已出账账单把金额落在账单行上，算法切换不改已出账金额
const ALGORITHMS = ['legacy', 'tiered'];
const ALGORITHM_LABELS = { legacy: '首重续重', tiered: '阶梯价' };
// 阶梯区间的边界口径：[下界, 上界) 左闭右开——重量正好等于下界时算本区间，正好等于上界时算下一区间
// 例如相邻两段 [0,5)、[5,10)：4.99kg 归第一段，5.00kg 归第二段
const TIER_BOUNDARY_RULE = '区间按 [下界, 上界) 左闭右开：重量等于下界算本区间，等于上界算下一区间（如 5.00kg 归 [5,10) 这一段）';

const DEFAULT_SETTINGS = {
  volumetricDivisor: 6000,
  minChargeYuan: 8,
  oversizeWeightKg: 30,
  oversizePieces: 3,
  oversizeFeeYuan: 20,
  insurancePermille: 20,
  pricingAlgorithm: 'legacy',
  pricingSwitchedAt: null,
};

function settingsOf(data) {
  return Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
}

function roundFen(yuan) {
  return Math.round(Number(yuan) * 100) / 100;
}

function roundUpToUnit(value, unit) {
  if (!(unit > 0)) return Number(value);
  return Math.ceil(Number(value) / unit) * unit;
}

function volumeWeightKg(volumeM3, divisor) {
  const volume = Number(volumeM3) || 0;
  const base = Number(divisor) > 0 ? Number(divisor) : DEFAULT_SETTINGS.volumetricDivisor;
  return (volume * 1000000) / base;
}

function billableWeightKg(waybill, settings) {
  const actual = Number(waybill.weightKg) || 0;
  const volume = volumeWeightKg(waybill.volumeM3, settings.volumetricDivisor);
  return roundUpToUnit(Math.max(actual, volume), 0.5);
}

function freightYuan(zone, billableKg, settings) {
  const firstWeightKg = Number(zone.firstWeightKg) || 1;
  const firstPriceYuan = Number(zone.firstPriceYuan) || 0;
  const addUnitKg = Number(zone.addUnitKg) || 0.5;
  const addPriceYuan = Number(zone.addPriceYuan) || 0;
  const over = Math.max(0, Number(billableKg) - firstWeightKg);
  const units = Math.ceil(over / addUnitKg);
  const raw = firstPriceYuan + units * addPriceYuan;
  const floor = Number(settings.minChargeYuan) || 0;
  return raw < floor ? floor : raw;
}

// 规范化阶梯区间（不做完整性校验，只做字段类型转换；完整性见 validateTiers）
function normalizeTiers(tiers) {
  if (!Array.isArray(tiers)) return [];
  return tiers.map((tier) => ({
    lowerKg: Number(tier.lowerKg),
    upperKg: tier.upperKg === null || tier.upperKg === '' || tier.upperKg === undefined ? null : Number(tier.upperKg),
    priceType: tier.priceType === 'flat' ? 'flat' : 'unit',
    priceYuan: Number(tier.priceYuan),
  }));
}

// 校验一组阶梯区间：至少一段、下界从 0 起、相邻段首尾相接（不重叠不留缺口）、仅最后一段可以不设上界
function validateTiers(tiers) {
  const list = normalizeTiers(tiers);
  if (list.length === 0) throw badRequestTier('ZONE_TIERS_EMPTY', '至少要登记一个重量区间');
  if (!(list[0].lowerKg === 0)) {
    throw badRequestTier('ZONE_TIERS_START', '第一个区间的下界必须是 0 kg');
  }
  for (let i = 0; i < list.length; i++) {
    const tier = list[i];
    if (!(Number.isFinite(tier.lowerKg) && tier.lowerKg >= 0)) {
      throw badRequestTier('ZONE_TIER_LOWER_INVALID', '第 ' + (i + 1) + ' 段的下界必须是不小于 0 的数字', i);
    }
    if (tier.upperKg !== null && !(Number.isFinite(tier.upperKg) && tier.upperKg > tier.lowerKg)) {
      throw badRequestTier('ZONE_TIER_UPPER_INVALID', '第 ' + (i + 1) + ' 段的上界必须大于下界（最后一段可以留空表示以上不限）', i);
    }
    if (!(Number.isFinite(tier.priceYuan) && tier.priceYuan >= 0)) {
      throw badRequestTier('ZONE_TIER_PRICE_INVALID', '第 ' + (i + 1) + ' 段的价格必须是不小于 0 的数字', i);
    }
    if (i < list.length - 1) {
      const next = list[i + 1];
      if (tier.upperKg === null) {
        throw badRequestTier('ZONE_TIERS_GAP', '只有最后一个区间可以不设上界', i);
      }
      if (!(next.lowerKg === tier.upperKg)) {
        throw badRequestTier(
          next.lowerKg < tier.upperKg ? 'ZONE_TIERS_OVERLAP' : 'ZONE_TIERS_GAP',
          '第 ' + (i + 1) + ' 段上界 ' + tier.upperKg + 'kg 与第 ' + (i + 2) + ' 段下界 ' + next.lowerKg + 'kg ' +
            (next.lowerKg < tier.upperKg ? '重叠了' : '之间留了缺口') + '，相邻区间必须首尾相接',
          i + 1
        );
      }
    }
  }
  return list;
}

// 返回本分区是否已配好一组完整可用的阶梯区间
function tiersReady(zone) {
  try {
    return validateTiers(zone && zone.tiers).length > 0;
  } catch (err) {
    return false;
  }
}

// 找到计费重量落在的区间（[下界, 上界)，重量等于上界时归下一段）
function tierOfKg(zone, billableKg) {
  const list = normalizeTiers(zone && zone.tiers);
  for (const tier of list) {
    if (billableKg >= tier.lowerKg && (tier.upperKg === null || billableKg < tier.upperKg)) return tier;
  }
  return null;
}

// 阶梯价运费：单价口径 = 计费重量 × 区间单价；整段价口径 = 该区间一口价；两者都不低于最低收费
function tieredFreightYuan(zone, billableKg, settings) {
  const tier = tierOfKg(zone, billableKg);
  if (!tier) return null;
  const raw = tier.priceType === 'flat' ? tier.priceYuan : billableKg * tier.priceYuan;
  const floor = Number(settings.minChargeYuan) || 0;
  return raw < floor ? floor : raw;
}

function effectiveAlgorithm(data) {
  const value = (data && data.settings && data.settings.pricingAlgorithm) || 'legacy';
  return ALGORITHMS.includes(value) ? value : 'legacy';
}

function badRequestTier(code, message, index) {
  const details = Number.isInteger(index) && index >= 0 ? { field: 'tiers', tierIndex: index } : { field: 'tiers' };
  return badRequest(code, message, details);
}

function surchargeYuan(zone, waybill, billableKg, settings) {
  let fee = Number(zone.remoteFeeYuan) || 0;
  const oversizeWeight = Number(billableKg) > Number(settings.oversizeWeightKg);
  const oversizePieces = Number(waybill.pieces || 1) >= Number(settings.oversizePieces);
  if (oversizeWeight || oversizePieces) fee += Number(settings.oversizeFeeYuan) || 0;
  const insured = Number(waybill.insuredAmountYuan) || 0;
  const services = Array.isArray(waybill.services) ? waybill.services : [];
  if (services.includes('保价') && insured > 0) {
    fee += insured * (Number(settings.insurancePermille) || 0) / 1000;
  }
  return fee;
}

function discountPermilleOf(customer) {
  if (!customer) return 1000;
  if (customer.settle !== '月结') return 1000;
  const value = Number(customer.discountPermille);
  return Number.isFinite(value) && value > 0 ? value : 1000;
}

function freightFor(algorithm, zone, billableKg, settings) {
  if (algorithm === 'tiered') return tieredFreightYuan(zone, billableKg, settings);
  return freightYuan(zone, billableKg, settings);
}

// 单条运单计费；algorithm 传 'legacy'（首重续重）或 'tiered'（阶梯价），不传按 settings 当前生效算法
function quoteWaybill(waybill, zone, customer, settings, algorithm) {
  const algo = algorithm || effectiveAlgorithm({ settings: settings });
  const billableKg = billableWeightKg(waybill, settings);
  let freight = freightFor(algo, zone, billableKg, settings);
  let tierMatched = null;
  if (algo === 'tiered') {
    if (freight === null) freight = Number(settings.minChargeYuan) || 0;
    const tier = tierOfKg(zone, billableKg);
    if (tier) tierMatched = { lowerKg: tier.lowerKg, upperKg: tier.upperKg, priceType: tier.priceType, priceYuan: tier.priceYuan };
  }
  const surcharge = surchargeYuan(zone, waybill, billableKg, settings);
  const permille = discountPermilleOf(customer);
  const gross = freight + surcharge;
  const total = roundFen(gross * permille / 1000);
  return {
    waybillId: waybill.id,
    zoneId: zone ? zone.id : null,
    zoneName: zone ? zone.name : '',
    algorithm: algo,
    billableKg,
    freightYuan: roundFen(freight),
    surchargeYuan: roundFen(surcharge),
    grossYuan: roundFen(gross),
    discountPermille: permille,
    totalYuan: total,
    tier: tierMatched,
  };
}

module.exports = {
  ALGORITHMS,
  ALGORITHM_LABELS,
  TIER_BOUNDARY_RULE,
  DEFAULT_SETTINGS,
  settingsOf,
  roundFen,
  roundUpToUnit,
  volumeWeightKg,
  billableWeightKg,
  freightYuan,
  freightFor,
  normalizeTiers,
  validateTiers,
  tiersReady,
  tierOfKg,
  tieredFreightYuan,
  effectiveAlgorithm,
  surchargeYuan,
  discountPermilleOf,
  quoteWaybill,
};
