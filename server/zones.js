const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const { TIER_KINDS, TIER_OPEN_AT_KG } = require('./pricing');

function cleanCity(value) {
  return String(value == null ? '' : value).trim();
}

// 阶梯区间口径：每段 [fromKg, toKg)，下界含、上界不含；末段上界填 TIER_OPEN_AT_KG 视为「以上」不限重
// 校验：至少一段；第一段下界必须是 0；各段按下界排序后首尾相接（前段上界 = 后段下界），不重叠也不留缺口
function validateWeightTiers(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('ZONE_TIERS_INVALID', '重量区间要按列表登记', { field: 'weightTiers' });
  const tiers = raw.map((item, index) => {
    const row = item && typeof item === 'object' ? item : {};
    const fromKg = Number(row.fromKg);
    const toKg = Number(row.toKg);
    const kind = String(row.kind || '').trim();
    const priceYuan = Number(row.priceYuan);
    const label = '第 ' + (index + 1) + ' 段';
    if (!(Number.isFinite(fromKg) && fromKg >= 0)) {
      throw badRequest('ZONE_TIER_FROM_INVALID', label + ' 的下界要填不小于 0 的数字', { field: 'weightTiers', index });
    }
    if (!(Number.isFinite(toKg) && toKg > fromKg)) {
      throw badRequest('ZONE_TIER_TO_INVALID', label + ' 的上界要大于下界', { field: 'weightTiers', index });
    }
    if (toKg > TIER_OPEN_AT_KG) {
      throw badRequest('ZONE_TIER_TO_INVALID', label + ' 的上界最大填 ' + TIER_OPEN_AT_KG + '（填 ' + TIER_OPEN_AT_KG + ' 表示以上不限重）', { field: 'weightTiers', index });
    }
    if (!TIER_KINDS.includes(kind)) {
      throw badRequest('ZONE_TIER_KIND_INVALID', label + ' 的算法要选「整段价」或「单价」', { field: 'weightTiers', index });
    }
    if (!(Number.isFinite(priceYuan) && priceYuan >= 0)) {
      throw badRequest('ZONE_TIER_PRICE_INVALID', label + ' 的价格要填不小于 0 的数字', { field: 'weightTiers', index });
    }
    return { fromKg, toKg, kind, priceYuan };
  });
  if (tiers.length === 0) return [];
  const sorted = tiers.slice().sort((a, b) => a.fromKg - b.fromKg);
  if (sorted[0].fromKg !== 0) {
    throw badRequest('ZONE_TIERS_NOT_FROM_ZERO', '第一个重量区间必须从 0kg 开始，不能在最轻的重量段留缺口', { field: 'weightTiers' });
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].fromKg !== sorted[i - 1].toKg) {
      throw badRequest(
        'ZONE_TIERS_GAP',
        '重量区间之间不能重叠也不能留缺口：' + sorted[i - 1].fromKg + '–' + sorted[i - 1].toKg +
          'kg 段的上界要正好等于下一段下界 ' + sorted[i].fromKg + 'kg',
        { field: 'weightTiers', index: i }
      );
    }
  }
  return sorted;
}

function listZones() {
  const data = load();
  return {
    zones: data.zones.map((zone) => ({
      id: zone.id,
      code: zone.code,
      name: zone.name,
      cities: zone.cities.slice(),
      aliases: Object.assign({}, zone.aliases),
      firstWeightKg: Number(zone.firstWeightKg),
      firstPriceYuan: Number(zone.firstPriceYuan),
      addUnitKg: Number(zone.addUnitKg),
      addPriceYuan: Number(zone.addPriceYuan),
      remoteFeeYuan: Number(zone.remoteFeeYuan || 0),
      weightTiers: (Array.isArray(zone.weightTiers) ? zone.weightTiers : []).map((tier) => ({
        fromKg: Number(tier.fromKg),
        toKg: Number(tier.toKg),
        kind: tier.kind,
        priceYuan: Number(tier.priceYuan),
      })),
      status: zone.status,
      citiesText: zone.cities.join('、'),
      aliasesText: Object.keys(zone.aliases || {}).join('、'),
    })),
    total: data.zones.length,
  };
}

function findZone(data, id) {
  return data.zones.find((zone) => zone.id === id) || null;
}

// 城市归属：先看各分区登记的别名，再看直接登记的城市
function zoneOfCity(data, city) {
  const target = cleanCity(city);
  if (!target) return null;
  for (const zone of data.zones) {
    const aliases = zone.aliases || {};
    if (Object.prototype.hasOwnProperty.call(aliases, target)) return zone;
  }
  return data.zones.find((zone) => zone.cities.map(cleanCity).includes(target)) || null;
}

function cityIndex(data) {
  const index = new Map();
  data.zones.forEach((zone) => {
    (zone.cities || []).forEach((city) => index.set(cleanCity(city), zone));
    Object.keys(zone.aliases || {}).forEach((alias) => index.set(cleanCity(alias), zone));
  });
  return index;
}

function validateZonePayload(payload, current) {
  const next = Object.assign({}, current || {}, payload || {});
  const code = String(next.code || '').trim();
  const name = String(next.name || '').trim();
  const status = next.status === undefined ? (current ? current.status : '启用') : String(next.status).trim();
  if (!code) throw badRequest('ZONE_CODE_REQUIRED', '分区编码必填', { field: 'code' });
  if (!/^Z[0-9]{1,2}$/.test(code)) throw badRequest('ZONE_CODE_INVALID', '分区编码要用 Z 加数字，例如 Z5', { field: 'code' });
  if (!name) throw badRequest('ZONE_NAME_REQUIRED', '分区名称必填', { field: 'name' });
  if (status !== '启用' && status !== '停用') throw badRequest('ZONE_STATUS_INVALID', '分区状态只能是启用或停用', { field: 'status' });
  const firstWeightKg = Number(next.firstWeightKg);
  const firstPriceYuan = Number(next.firstPriceYuan);
  const addUnitKg = Number(next.addUnitKg);
  const addPriceYuan = Number(next.addPriceYuan);
  const remoteFeeYuan = Number(next.remoteFeeYuan === undefined ? 0 : next.remoteFeeYuan);
  if (!(firstWeightKg > 0)) throw badRequest('ZONE_FIRST_WEIGHT_INVALID', '首重必须是大于 0 的数字', { field: 'firstWeightKg' });
  if (!(firstPriceYuan >= 0)) throw badRequest('ZONE_FIRST_PRICE_INVALID', '首重价必须是不小于 0 的数字', { field: 'firstPriceYuan' });
  if (!(addUnitKg > 0)) throw badRequest('ZONE_ADD_UNIT_INVALID', '续重单位必须是大于 0 的数字', { field: 'addUnitKg' });
  if (!(addPriceYuan >= 0)) throw badRequest('ZONE_ADD_PRICE_INVALID', '续重价必须是不小于 0 的数字', { field: 'addPriceYuan' });
  if (!(remoteFeeYuan >= 0)) throw badRequest('ZONE_REMOTE_FEE_INVALID', '偏远附加必须是不小于 0 的数字', { field: 'remoteFeeYuan' });
  const cities = Array.isArray(next.cities) ? next.cities.map(cleanCity).filter(Boolean) : [];
  const aliases = {};
  const rawAliases = next.aliases && typeof next.aliases === 'object' ? next.aliases : {};
  Object.keys(rawAliases).forEach((key) => {
    const alias = cleanCity(key);
    const target = cleanCity(rawAliases[key]);
    if (!alias) return;
    if (!target) throw badRequest('ZONE_ALIAS_TARGET_REQUIRED', '别名要写明对应哪个城市：' + alias, { field: 'aliases' });
    aliases[alias] = target;
  });
  // 区间列表允许不传（沿用原值）或传空数组（还没配阶梯价）；非空时必须通过区间校验
  const weightTiers = Object.prototype.hasOwnProperty.call(next, 'weightTiers')
    ? validateWeightTiers(next.weightTiers)
    : (Array.isArray(current && current.weightTiers) ? current.weightTiers : []);
  return { code, name, status, firstWeightKg, firstPriceYuan, addUnitKg, addPriceYuan, remoteFeeYuan, cities, aliases, weightTiers };
}

function createZone(payload) {
  const data = load();
  const clean = validateZonePayload(payload, null);
  if (data.zones.some((zone) => zone.code === clean.code)) {
    throw badRequest('ZONE_CODE_DUPLICATE', '分区编码 ' + clean.code + ' 已经存在', { field: 'code' });
  }
  const zone = Object.assign({ id: nextId('zone', data.zones) }, clean);
  data.zones.push(zone);
  save(data);
  return zone;
}

function updateZone(id, payload) {
  const data = load();
  const current = findZone(data, id);
  if (!current) throw notFound('ZONE_NOT_FOUND', '分区不存在');
  const clean = validateZonePayload(payload, current);
  if (data.zones.some((zone) => zone.id !== id && zone.code === clean.code)) {
    throw badRequest('ZONE_CODE_DUPLICATE', '分区编码 ' + clean.code + ' 已经存在', { field: 'code' });
  }
  Object.assign(current, clean);
  save(data);
  return current;
}

function removeZone(id) {
  const data = load();
  const current = findZone(data, id);
  if (!current) throw notFound('ZONE_NOT_FOUND', '分区不存在');
  const index = cityIndex(data);
  const used = data.waybills.filter((waybill) => {
    const zone = index.get(cleanCity(waybill.toCity));
    return zone && zone.id === id;
  });
  if (used.length > 0) {
    throw badRequest('ZONE_IN_USE', '这个分区下的城市还有 ' + used.length + ' 条运单在用，先处理完再删', { count: used.length });
  }
  data.zones = data.zones.filter((zone) => zone.id !== id);
  save(data);
  return { removed: id };
}

module.exports = { listZones, findZone, zoneOfCity, cityIndex, createZone, updateZone, removeZone, cleanCity };
