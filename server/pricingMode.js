const { badRequest } = require('./errors');
const store = require('./store');
const pricing = require('./pricing');
const zonesSvc = require('./zones');
const { findCustomer } = require('./customers');

function currentMode(data) {
  return (data.pricing && data.pricing.mode) || pricing.DEFAULT_MODE;
}

function tiersReady(zone) {
  return Array.isArray(zone.weightTiers) && zone.weightTiers.length > 0;
}

// 切到阶梯价之前，所有启用分区都必须已经登记完整区间，停用分区不拦
function enabledZonesMissingTiers(data) {
  return data.zones.filter((zone) => zone.status === '启用' && !tiersReady(zone));
}

function decorateHistory(record) {
  if (!record) return null;
  return Object.assign({}, record, {
    atText: String(record.at || '').replace('T', ' ').slice(0, 16),
  });
}

function pricingStatus(data) {
  const missing = enabledZonesMissingTiers(data).map((zone) => ({
    id: zone.id, code: zone.code, name: zone.name,
  }));
  return {
    mode: currentMode(data),
    modes: pricing.MODES.slice(),
    tieredReady: missing.length === 0,
    enabledZoneCount: data.zones.filter((zone) => zone.status === '启用').length,
    missingTierZones: missing,
    history: ((data.pricing && data.pricing.history) || []).slice(-20).reverse().map(decorateHistory),
  };
}

// 未出账运单 = 还没挂账单（billId 为空）；已进账单（含后来作废的）金额随账单冻结，不在试算范围
function unbilledWaybills(data, customerId) {
  return data.waybills
    .filter((waybill) => !waybill.billId && (!customerId || waybill.customerId === customerId))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.code).localeCompare(String(b.code)));
}

function compareAll(query) {
  const data = store.load();
  const customerId = String((query && query.customerId) || '').trim();
  const settings = pricing.settingsOf(data);
  const targets = unbilledWaybills(data, customerId);
  const rows = targets.map((waybill) => {
    const customer = findCustomer(data, waybill.customerId);
    const zone = zonesSvc.zoneOfCity(data, waybill.toCity);
    const base = {
      waybillId: waybill.id,
      code: waybill.code,
      customerName: customer ? customer.name : '（客户已删）',
      toCity: waybill.toCity,
      createdAt: waybill.createdAt,
      zoneId: zone ? zone.id : null,
      zoneName: zone ? zone.name : '',
      zoneKnown: Boolean(zone),
    };
    if (!zone) {
      return Object.assign(base, {
        billableKg: null,
        firstAdd: null,
        tiered: null,
        diffYuan: null,
      });
    }
    const cmp = pricing.compareWaybill(waybill, zone, customer, settings);
    return Object.assign(base, {
      billableKg: cmp.billableKg,
      firstAdd: cmp.firstAdd,
      tiered: cmp.tiered,
      diffYuan: cmp.diffYuan,
    });
  });

  const priced = rows.filter((row) => row.firstAdd);
  const sumOf = (pick) => pricing.roundFen(priced.reduce((sum, row) => sum + Number(pick(row) || 0), 0));
  const firstAddTotal = sumOf((row) => row.firstAdd.totalYuan);
  const tieredTotal = sumOf((row) => row.tiered.totalYuan);
  return {
    mode: currentMode(data),
    customerId,
    totals: {
      firstAddYuan: firstAddTotal,
      tieredYuan: tieredTotal,
      diffYuan: pricing.roundFen(tieredTotal - firstAddTotal),
    },
    counts: {
      all: rows.length,
      priced: priced.length,
      unzoned: rows.filter((row) => !row.zoneKnown).length,
      missingTier: rows.filter((row) => row.zoneKnown && row.tiered && row.tiered.missingTier).length,
    },
    rows,
  };
}

// 整体落定算法切换：落定后新算的运单/新出的账单按新算法；已出账账单金额原样不动
function switchMode(target) {
  const data = store.load();
  const mode = String(target || '').trim();
  if (!pricing.MODES.includes(mode)) {
    throw badRequest('PRICING_MODE_INVALID', '算法只能是 first_add（首重续重）或 tiered（阶梯价）', { field: 'mode' });
  }
  const from = currentMode(data);
  if (mode === from) {
    throw badRequest('PRICING_MODE_SAME', '当前已经是这种算法，不需要切换', { field: 'mode' });
  }
  if (mode === 'tiered') {
    // 启用分区必须配齐；另外即使分区已停用，只要还有未出账运单会命中它，也得配齐，否则那些单算不出钱
    const settings0 = pricing.settingsOf(data);
    const usedMap = new Map();
    data.waybills.filter((waybill) => !waybill.billId).forEach((waybill) => {
      const z = zonesSvc.zoneOfCity(data, waybill.toCity);
      if (z) usedMap.set(z.id, z);
    });
    const usedMissing = Array.from(usedMap.values()).filter((z) => z.status !== '启用' && !tiersReady(z));
    const missing = enabledZonesMissingTiers(data).concat(usedMissing);
    if (missing.length > 0) {
      const uniq = Array.from(new Map(missing.map((z) => [z.id, z])).values());
      throw badRequest(
        'PRICING_TIERS_NOT_READY',
        '还有 ' + uniq.length + ' 个分区没登记重量区间（' + uniq.map((z) => z.code + ' ' + z.name).join('、') + '），配齐之后再切到阶梯价',
        { zones: uniq.map((z) => z.id) }
      );
    }
  }

  // 记录这次切换影响哪些未出账运单，以及两种算法下的合计差额
  const settings = pricing.settingsOf(data);
  const affected = unbilledWaybills(data, '').filter((waybill) => zonesSvc.zoneOfCity(data, waybill.toCity));
  let firstAddTotal = 0;
  let tieredTotal = 0;
  affected.forEach((waybill) => {
    const customer = findCustomer(data, waybill.customerId);
    const zone = zonesSvc.zoneOfCity(data, waybill.toCity);
    firstAddTotal += pricing.quoteWaybill(waybill, zone, customer, settings, 'first_add').totalYuan;
    tieredTotal += pricing.quoteWaybill(waybill, zone, customer, settings, 'tiered').totalYuan;
  });
  firstAddTotal = pricing.roundFen(firstAddTotal);
  tieredTotal = pricing.roundFen(tieredTotal);

  const record = {
    at: new Date().toISOString(),
    fromMode: from,
    toMode: mode,
    affectedCount: affected.length,
    affectedIds: affected.map((waybill) => waybill.id),
    affectedCodes: affected.map((waybill) => waybill.code),
    totals: {
      firstAddYuan: firstAddTotal,
      tieredYuan: tieredTotal,
      diffYuan: pricing.roundFen(tieredTotal - firstAddTotal),
    },
  };
  data.pricing.mode = mode;
  data.pricing.history = Array.isArray(data.pricing.history) ? data.pricing.history : [];
  data.pricing.history.push(record);
  store.save(data);

  return {
    status: pricingStatus(store.load()),
    switched: decorateHistory(record),
  };
}

module.exports = { currentMode, tiersReady, pricingStatus, compareAll, switchMode };
