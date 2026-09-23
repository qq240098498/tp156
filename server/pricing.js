// 计费口径（本项目现有实现）
// 1. 计费重量 = max(实际重量, 体积重量)，体积重量 = 体积(m³) × 1000000 ÷ 体积系数，结果向上取到 0.5kg
// 2-A. 首重续重：首重以内收首重价，超出部分按续重单位向上进位，每个单位收续重价
// 2-B. 阶梯价：计费重量落在哪个重量区间就按该区间计费；区间为「上界不含、下界含」，即 [下界, 上界)，
//      例如 1.0kg 落在 [1.0, 3.0) 而不是 [0, 1.0)；计费重量已向上取到 0.5kg，恰为区间边界时归到上一段。
//      每段可选「整段价」（落段即收固定金额）或「单价」（金额 = 单价 × 计费重量，向上取到分）。
// 3. 运费不低于最低收费（仅首重续重模式套用，阶梯价以区间登记金额为准）
// 4. 附加费 = 偏远附加（按分区）+ 超规附加（计费重量超限或件数超限）+ 保价费（保价金额 × 费率）
// 5. 月结客户按折扣作用于运费与附加费合计，现结客户不打折；费用以元为单位，保留两位
const DEFAULT_SETTINGS = {
  volumetricDivisor: 6000,
  minChargeYuan: 8,
  oversizeWeightKg: 30,
  oversizePieces: 3,
  oversizeFeeYuan: 20,
  insurancePermille: 20,
};

// 系统支持的两种算法；first_add = 首重续重（旧），tiered = 重量阶梯（新）
const MODES = ['first_add', 'tiered'];
const DEFAULT_MODE = 'first_add';

// 阶梯区间的两种计法：flat = 整段价（落段收固定金额），unit = 单价（单价 × 计费重量）
const TIER_KINDS = ['flat', 'unit'];

// 区间上界允许填的最大值：填到这里视为「以上」（无上界）
const TIER_OPEN_AT_KG = 99999;

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

// 找到计费重量落在的区间：口径 [fromKg, toKg)，重量等于下界归本段、等于上界归下一段
function tierOfWeight(zone, billableKg) {
  const tiers = Array.isArray(zone.weightTiers) ? zone.weightTiers : [];
  const weight = Number(billableKg) || 0;
  return tiers.find((tier) => weight >= Number(tier.fromKg) && weight < Number(tier.toKg)) || null;
}

// 阶梯价运费：整段价直接取登记金额；单价 = 单价 × 计费重量，向上取到分
function tieredFreightYuan(zone, billableKg) {
  const tier = tierOfWeight(zone, billableKg);
  if (!tier) return null;
  if (tier.kind === 'unit') {
    return Math.ceil((Number(tier.priceYuan) || 0) * Number(billableKg) * 100) / 100;
  }
  return Number(tier.priceYuan) || 0;
}

// 按指定算法算运费，返回金额与命中的区间（首重续重没有区间概念）
function freightByMode(zone, billableKg, settings, mode) {
  if (mode === 'tiered') {
    return { amount: tieredFreightYuan(zone, billableKg), tier: tierOfWeight(zone, billableKg) };
  }
  return { amount: freightYuan(zone, billableKg, settings), tier: null };
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

// 单条运单计费
function quoteWaybill(waybill, zone, customer, settings, mode) {
  const algo = MODES.includes(mode) ? mode : DEFAULT_MODE;
  const billableKg = billableWeightKg(waybill, settings);
  const priced = freightByMode(zone, billableKg, settings, algo);
  const freight = priced.amount == null ? 0 : priced.amount;
  const surcharge = surchargeYuan(zone, waybill, billableKg, settings);
  const permille = discountPermilleOf(customer);
  const gross = freight + surcharge;
  const total = roundFen(gross * permille / 1000);
  return {
    waybillId: waybill.id,
    zoneId: zone ? zone.id : null,
    zoneName: zone ? zone.name : '',
    mode: algo,
    billableKg,
    freightYuan: roundFen(freight),
    surchargeYuan: roundFen(surcharge),
    grossYuan: roundFen(gross),
    discountPermille: permille,
    totalYuan: total,
    tier: priced.tier ? {
      fromKg: Number(priced.tier.fromKg),
      toKg: Number(priced.tier.toKg),
      kind: priced.tier.kind,
      priceYuan: Number(priced.tier.priceYuan),
    } : null,
    missingTier: algo === 'tiered' && priced.tier == null,
  };
}

// 同一条运单分别按两种算法试算，差额 = 阶梯价 - 首重续重（正数表示阶梯价收得更高）
function compareWaybill(waybill, zone, customer, settings) {
  const firstAdd = quoteWaybill(waybill, zone, customer, settings, 'first_add');
  const tiered = quoteWaybill(waybill, zone, customer, settings, 'tiered');
  return {
    waybillId: waybill.id,
    zoneId: zone ? zone.id : null,
    zoneName: zone ? zone.name : '',
    billableKg: firstAdd.billableKg,
    firstAdd: {
      freightYuan: firstAdd.freightYuan,
      totalYuan: firstAdd.totalYuan,
    },
    tiered: {
      freightYuan: tiered.freightYuan,
      totalYuan: tiered.totalYuan,
      tier: tiered.tier,
      missingTier: tiered.missingTier,
    },
    diffYuan: roundFen(tiered.totalYuan - firstAdd.totalYuan),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  MODES,
  DEFAULT_MODE,
  TIER_KINDS,
  TIER_OPEN_AT_KG,
  settingsOf,
  roundFen,
  roundUpToUnit,
  volumeWeightKg,
  billableWeightKg,
  freightYuan,
  tierOfWeight,
  tieredFreightYuan,
  freightByMode,
  surchargeYuan,
  discountPermilleOf,
  quoteWaybill,
  compareWaybill,
};
