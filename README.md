# 运单计费与账单核对台

面向物流结算岗位的运单计费与账单核对工具。运单录进来，按分区与重量口径算出运费与附加费，按月出账，出账之后要能核对账单总额与逐单明细是否对得上。

## 怎么跑

```
npm install
npm start
```

启动后打开 http://localhost:5150 。数据存在 `data/db.json`，页面上的改动会直接写回这个文件。

## 页面能做什么

- 概览：分区、客户、运单、账单的数量与金额合计，运单状态分布，已有账期，未归属城市的运单数
- 运单：登记与维护运单（客户、寄件城市、收件城市、实际重量、体积、件数、保价金额、附加服务、状态、创建时刻），支持按关键词、客户、状态筛选，可以只看收件城市还没归属分区的运单
- 运单计费：对单条运单算一次费用，结果会记在这条运单上，页面上直接能看到上次算出来的数
- 分区：维护分区编码、名称、覆盖城市与城市别名、首重与续重价格、偏远附加、启用状态
- 定价：给每个分区登记重量阶梯区间与对应价格；同一批未出账运单按「首重续重 / 阶梯价」两种算法并排试算，逐单列出两种金额、差额与合计；确认后整体切换算法
- 客户：维护客户编码、名称、结算方式（月结／现结）、折扣、账期日
- 账单：按账期与客户出账，查看账单总额与逐条明细，可以把账单作废

## 计费口径

1. 计费重量 = max(实际重量, 体积重量)；体积重量 = 体积(m³) × 1000000 ÷ 体积系数（默认 6000），结果向上取到 0.5kg
2. 运费有两种可切换的算法：
   - **首重续重**：首重以内收首重价；超出首重的部分按续重单位向上进位，每个单位收续重价；运费不低于最低收费（默认 8 元）
   - **重量阶梯**：计费重量落在哪个区间就按该区间计费。区间口径为 **[下界, 上界)**——下界含、上界不含，例如重量正好 1.0kg 归 [1.0, 3.0) 而不是 [0, 1.0)。每段可选「整段价」（落段收固定金额）或「单价」（单价 × 计费重量，向上取到分）。区间第一段必须从 0kg 起，相邻两段首尾相接（前段上界 = 后段下界），不能重叠也不能留缺口，最后一段为「以上」覆盖所有更大重量
3. 两种算法并存可随时在「定价」页对**未出账运单**逐单试算对比，差额 = 阶梯价 − 首重续重；区间配置保存后试算结果立即重算
4. 算法切换是**全局落定**：落定之后新算的运单、新出的账单按新算法；已经出账的账单金额原样冻结，不随切换或改价变化。切换时会记录这次影响哪些未出账运单（运单号与两种算法合计）
5. 附加费 = 偏远附加（按分区）+ 超规附加（计费重量超过 30kg 或件数达到 3 件，20 元）+ 保价费（保价金额 × 2%）
6. 月结客户按折扣作用于运费与附加费合计，现结客户不打折；金额以元为单位，页面保留两位小数
7. 账期按运单创建时刻所在的月份归集；运单进账单之后会被锁定，不能再直接删改

## 目录

```
server/index.js     服务入口
server/api.js       接口路由与错误处理
server/store.js     数据读写
server/pricing.js   计费口径（首重续重 + 重量阶梯）
server/pricingMode.js 算法状态、双算法试算、整体切换
server/zones.js     分区、城市归属与重量区间校验
server/customers.js 客户
server/waybills.js  运单与单条计费
server/bills.js     出账与账单
public/             页面
data/db.json        数据
```

## 接口一览

```
GET    /api/health
GET    /api/summary
GET    /api/settings             PATCH /api/settings
GET    /api/zones                POST /api/zones      PATCH|DELETE /api/zones/:id
GET    /api/pricing              GET  /api/pricing/compare?customerId=
POST   /api/pricing/mode
GET    /api/customers            POST /api/customers  PATCH|DELETE /api/customers/:id
GET    /api/waybills             POST /api/waybills   PATCH|DELETE /api/waybills/:id
POST   /api/waybills/:id/quote
GET    /api/bills                GET /api/bills/:id
POST   /api/bills/generate       POST /api/bills/:id/void
GET    /api/periods
```

切换算法入参：`{ "mode": "tiered" }`（另一个取值 `first_add`）。分区的重量区间挂在分区上，随 `POST/PATCH /api/zones` 的 `weightTiers` 一起保存，每段形如 `{ "fromKg": 0, "toKg": 1, "kind": "flat", "priceYuan": 8 }`（`kind` 取 `flat` 整段价或 `unit` 单价，末段 `toKg` 为 99999 表示「以上」）。

出账入参：`{ "period": "2026-09", "customerId": "cust-0001" }`
