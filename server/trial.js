const { badRequest } = require('./errors');
const { load, save } = require('./store');
const pricing = require('./pricing');
const zones = require('./zones');
const { findCustomer } = require('./customers');
const { periodOf } = require('./bills');

// 一条运单在两种算法下的计费结果
function dualQuote(data, waybill, settings) {
  const zone = zones.zoneOfCity(data, waybill.toCity);
  const customer = findCustomer(data, waybill.customerId);
  const legacy = pricing.quoteWaybill(waybill, zone, customer, settings, 'legacy');
  const tiered = pricing.quoteWaybill(waybill, zone, customer, settings, 'tiered');
  const bill = data.bills.find((item) => item.id === waybill.billId) || null;
  return {
    waybillId: waybill.id,
    code: waybill.code,
    customerId: waybill.customerId,
    customerName: customer ? customer.name : '（客户已删）',
    toCity: waybill.toCity,
    zoneId: zone ? zone.id : null,
    zoneName: zone ? zone.name : '未归属',
    zoneKnown: Boolean(zone),
    createdAt: waybill.createdAt,
    period: periodOf(waybill),
    billId: waybill.billId || null,
    billCode: bill ? bill.code : '',
    billStatus: bill ? bill.status : '',
    locked: Boolean(waybill.billId),
    billableKg: legacy.billableKg,
    legacy: {
      freightYuan: legacy.freightYuan,
      surchargeYuan: legacy.surchargeYuan,
      totalYuan: legacy.totalYuan,
    },
    tiered: {
      freightYuan: tiered.freightYuan,
      surchargeYuan: tiered.surchargeYuan,
      totalYuan: tiered.totalYuan,
      tier: tiered.tier,
    },
    diffYuan: pricing.roundFen(tiered.totalYuan - legacy.totalYuan),
  };
}

function sumRows(rows) {
  return rows.reduce((acc, row) => ({
    legacyYuan: pricing.roundFen(acc.legacyYuan + row.legacy.totalYuan),
    tieredYuan: pricing.roundFen(acc.tieredYuan + row.tiered.totalYuan),
    diffYuan: pricing.roundFen(acc.diffYuan + row.diffYuan),
  }), { legacyYuan: 0, tieredYuan: 0, diffYuan: 0 });
}

// 双算法试算：同一批运单分别按首重续重与阶梯价算一遍
function trialPricing(query) {
  const data = load();
  const settings = pricing.settingsOf(data);
  const customerId = String((query && query.customerId) || '').trim();
  const period = String((query && query.period) || '').trim();
  let rows = data.waybills.map((waybill) => dualQuote(data, waybill, settings));
  if (customerId) rows = rows.filter((row) => row.customerId === customerId);
  if (period) rows = rows.filter((row) => row.period === period);
  const unzoned = rows.filter((row) => !row.zoneKnown);
  const priced = rows.filter((row) => row.zoneKnown);
  const unbilled = priced.filter((row) => !row.locked);
  const billed = priced.filter((row) => row.locked);
  priced.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const enabledZones = data.zones.filter((zone) => zone.status === '启用');
  return {
    currentAlgorithm: pricing.effectiveAlgorithm(data),
    algorithmLabels: pricing.ALGORITHM_LABELS,
    boundaryRule: pricing.TIER_BOUNDARY_RULE,
    switchedAt: settings.pricingSwitchedAt || null,
    filters: { customerId, period },
    rows: priced,
    unzonedCount: unzoned.length,
    unzonedCodes: unzoned.map((row) => row.code),
    totals: sumRows(priced),
    totalsUnbilled: sumRows(unbilled),
    totalsBilled: sumRows(billed),
    counts: {
      all: priced.length,
      unbilled: unbilled.length,
      billed: billed.length,
    },
    zones: enabledZones.map((zone) => ({
      id: zone.id,
      code: zone.code,
      name: zone.name,
      tiersReady: pricing.tiersReady(zone),
      tiers: pricing.normalizeTiers(zone.tiers),
    })),
  };
}

// 整体切换生效算法：已出账账单金额不动（金额落在账单行上），只清未出账运单的试算缓存
function switchAlgorithm(payload) {
  const data = load();
  const target = String((payload && payload.algorithm) || '').trim();
  if (!pricing.ALGORITHMS.includes(target)) {
    throw badRequest('PRICING_ALGORITHM_INVALID', '算法只能是 legacy（首重续重）或 tiered（阶梯价）', { field: 'algorithm' });
  }
  const current = pricing.effectiveAlgorithm(data);
  if (target === current) {
    throw badRequest('PRICING_ALGORITHM_SAME', '当前生效的已经是「' + pricing.ALGORITHM_LABELS[target] + '」，不用切换', { field: 'algorithm' });
  }
  // 切到阶梯价之前，每个启用分区都要有一组完整区间
  if (target === 'tiered') {
    const missing = data.zones
      .filter((zone) => zone.status === '启用' && !pricing.tiersReady(zone))
      .map((zone) => zone.code + ' ' + zone.name);
    if (missing.length > 0) {
      throw badRequest('PRICING_TIERS_NOT_READY',
        '还有启用分区没配好重量区间，不能切到阶梯价：' + missing.join('、') +
        '。区间必须从 0kg 起首尾相接，不能重叠也不能留缺口', { zones: missing });
    }
  }
  const settings = pricing.settingsOf(data);
  const switchedAt = new Date().toISOString();
  data.settings.pricingAlgorithm = target;
  data.settings.pricingSwitchedAt = switchedAt;

  const unbilled = data.waybills.filter((waybill) => !waybill.billId);
  const clearedCaches = [];
  unbilled.forEach((waybill) => {
    if (waybill.quoteCacheYuan != null) clearedCaches.push(waybill.code);
    waybill.quoteCacheYuan = null;
    waybill.quoteCachedAt = null;
  });
  save(data);

  const fresh = load();
  const affected = unbilled
    .map((waybill) => dualQuote(fresh, waybill, pricing.settingsOf(fresh)))
    .filter((row) => row.zoneKnown)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    algorithm: target,
    previousAlgorithm: current,
    switchedAt,
    boundaryRule: pricing.TIER_BOUNDARY_RULE,
    affectedCount: affected.length,
    affectedCodes: affected.map((row) => row.code),
    clearedCacheCodes: clearedCaches,
    billedUnchangedCount: data.waybills.filter((waybill) => Boolean(waybill.billId)).length,
    totalsUnbilled: sumRows(affected),
    affectedRows: affected,
  };
}

module.exports = { trialPricing, switchAlgorithm };
