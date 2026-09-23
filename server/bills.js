const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const pricingMode = require('./pricingMode');
const { findCustomer } = require('./customers');

function cleanCity(value) {
  return String(value == null ? '' : value).trim();
}

// 账单里的分区判断：拿收件城市跟各分区登记的城市直接比
function zoneOf(data, city) {
  const target = cleanCity(city);
  const matched = data.zones.find((zone) => (zone.cities || []).some((item) => cleanCity(item) === target));
  return matched || data.zones[0] || null;
}

// 账期：按运单创建时刻的年月
function periodOf(waybill) {
  const date = new Date(String(waybill.createdAt || ''));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 7);
}

function candidateWaybills(data, period, customerId) {
  return data.waybills.filter((waybill) => waybill.customerId === customerId && periodOf(waybill) === period);
}

// 出账计费：
// - 首重续重：同一账期同一客户的运单合起来算一次首重续重，再按各自的计费重量分摊
// - 阶梯价：每条运单按自己的计费重量落段独立计运费，附加费照旧逐单算，最后合计
function priceBill(data, customer, waybills, mode) {
  const settings = pricing.settingsOf(data);
  const permille = pricing.discountPermilleOf(customer);
  if (waybills.length === 0) return { lines: [], amountYuan: 0, permille, mode };
  const zone = zoneOf(data, waybills[0].toCity);
  const weights = waybills.map((waybill) => pricing.billableWeightKg(waybill, settings));

  let lines;
  let amountYuan;

  if (mode === 'tiered') {
    waybills.forEach((waybill, index) => {
      const weight = weights[index];
      if (!pricing.tierOfWeight(zone, weight)) {
        throw badRequest(
          'BILL_TIER_UNCOVERED',
          '运单 ' + waybill.code + ' 的计费重量 ' + weight + 'kg 落在分区「' + (zone ? zone.name : '未归属') + '」已登记区间之外，先到定价页补齐区间再出账',
          { waybillId: waybill.id, billableKg: weight }
        );
      }
    });
    lines = waybills.map((waybill, index) => {
      const weight = weights[index];
      const tier = pricing.tierOfWeight(zone, weight);
      const freight = pricing.tieredFreightYuan(zone, weight);
      const surcharge = pricing.surchargeYuan(zone, waybill, weight, settings);
      const cached = Number(waybill.quoteCacheYuan);
      const raw = (freight + surcharge) * permille / 1000;
      // 缓存的单条计费只有在同一算法下才采信，避免拿旧算法的金额进新算法的账单
      const sameMode = waybill.quoteMode === 'tiered';
      const amount = sameMode && cached > 0 ? cached : pricing.roundFen(raw);
      return {
        waybillId: waybill.id,
        code: waybill.code,
        toCity: waybill.toCity,
        zoneName: zone ? zone.name : '',
        billableKg: weight,
        tierFromKg: Number(tier.fromKg),
        tierToKg: Number(tier.toKg),
        amountYuan: amount,
        fromCache: sameMode && cached > 0,
      };
    });
    amountYuan = lines.reduce((sum, line) => sum + line.amountYuan, 0);
  } else {
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const freightAll = pricing.freightYuan(zone, totalWeight, settings);
    const surchargeAll = waybills.reduce((sum, waybill, index) => (
      sum + pricing.surchargeYuan(zone, waybill, weights[index], settings)
    ), 0);
    const grossAll = freightAll + surchargeAll;
    amountYuan = grossAll * permille / 1000;
    lines = waybills.map((waybill, index) => {
      const weight = weights[index];
      const share = totalWeight > 0 ? weight / totalWeight : 0;
      const raw = (freightAll * share + pricing.surchargeYuan(zone, waybill, weight, settings)) * permille / 1000;
      const cached = Number(waybill.quoteCacheYuan);
      const sameMode = !waybill.quoteMode || waybill.quoteMode === 'first_add';
      const amount = sameMode && cached > 0 ? cached : pricing.roundFen(raw);
      return {
        waybillId: waybill.id,
        code: waybill.code,
        toCity: waybill.toCity,
        zoneName: zone ? zone.name : '',
        billableKg: weight,
        amountYuan: amount,
        fromCache: sameMode && cached > 0,
      };
    });
  }

  return { lines, amountYuan, permille, mode };
}

function summarizeBill(bill, data) {
  const customer = findCustomer(data, bill.customerId);
  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  const lineSum = lines.reduce((sum, line) => sum + Number(line.amountYuan || 0), 0);
  const waybills = (bill.waybillIds || [])
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean);
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    pricingMode: bill.pricingMode || 'first_add',
    pricingModeText: bill.pricingMode === 'tiered' ? '阶梯价' : '首重续重',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    lines: lines.map((line) => Object.assign({}, line, {
      amountText: Number(line.amountYuan || 0).toFixed(2),
      billableText: Number(line.billableKg).toFixed(2) + ' kg',
      tierText: line.tierFromKg != null
        ? '[' + Number(line.tierFromKg) + ', ' + Number(line.tierToKg) + ')'
        : '',
    })),
    waybills: waybills.map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      weightKg: Number(waybill.weightKg),
      createdAt: waybill.createdAt,
      quoteCacheYuan: waybill.quoteCacheYuan,
    })),
  });
}

function listBills(query) {
  const data = load();
  const customerId = String((query && query.customerId) || '').trim();
  const status = String((query && query.status) || '').trim();
  let bills = data.bills.map((bill) => summarizeBill(bill, data));
  if (customerId) bills = bills.filter((bill) => bill.customerId === customerId);
  if (status) bills = bills.filter((bill) => bill.status === status);
  bills.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(b.code).localeCompare(String(a.code)));
  return {
    bills,
    total: bills.length,
    issued: bills.filter((bill) => bill.status === '已出账').length,
    voided: bills.filter((bill) => bill.status === '已作废').length,
  };
}

function findBill(data, id) {
  return data.bills.find((bill) => bill.id === id) || null;
}

function getBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  return summarizeBill(bill, data);
}

function generateBill(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = candidateWaybills(data, period, customerId);
  if (targets.length === 0) throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户没有可以出账的运单', { field: 'period' });
  const mode = pricingMode.currentMode(data);
  const priced = priceBill(data, customer, targets, mode);
  const samePeriod = data.bills.filter((bill) => bill.period === period && bill.customerId === customerId).length;
  const bill = {
    id: nextId('bill', data.bills),
    code: 'ZD' + period.replace('-', '') + '-' + customer.code + String(samePeriod + 1).padStart(2, '0'),
    period,
    customerId,
    status: '已出账',
    createdAt: new Date().toISOString(),
    pricingMode: mode,
    waybillIds: targets.map((waybill) => waybill.id),
    lines: priced.lines,
    amountYuan: priced.amountYuan,
    discountPermille: priced.permille,
  };
  data.bills.push(bill);
  targets.forEach((waybill) => {
    waybill.billId = bill.id;
  });
  save(data);
  return summarizeBill(bill, load());
}

function voidBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  if (bill.status === '已作废') throw badRequest('BILL_ALREADY_VOID', '这张账单已经作废了');
  bill.status = '已作废';
  bill.voidedAt = new Date().toISOString();
  save(data);
  return summarizeBill(bill, load());
}

function listPeriods() {
  const data = load();
  const periods = new Set();
  data.waybills.forEach((waybill) => {
    const period = periodOf(waybill);
    if (period) periods.add(period);
  });
  data.bills.forEach((bill) => periods.add(bill.period));
  return { periods: Array.from(periods).sort() };
}

module.exports = { listBills, getBill, generateBill, voidBill, listPeriods, periodOf, zoneOf };
