# ai0_global — внутрішній пітч для команди

> **Мета цього набору документів:** чесно й без «маркетингового причісування» пояснити команді, **що це за система, як вона працює, на чому тримається і де в неї слабкі місця.** Це не пітч для інвесторів — тут навмисно однаково докладно описані і сильні, і слабкі сторони. Далі з цього можна робити презентацію в Cowork.

Усе нижче **грунтовано на реальному коді** (станом на гілку `feat/strategy-improvements`), а не на побажаннях. Технічні терміни та назви (таблиці, модулі, сервіси) залишені англійською — так, як у коді.

## Що це одним абзацом

**ai0_global** — це one-person **медіа-мережа** (single-tenant, не SaaS): один власник керує портфелем із **16 автоматизованих контент-стратегій**, які парсять/генерують/публікують контент у **Telegram** (основне), **Meta** (Instagram/Facebook/Threads) і **TikTok**, з централізованим трекінгом у одному Postgres і одному NestJS-процесі. Поверх цього збудований **агент-оператор** — 4-етапна петля монетизації, що перетворює аудиторію на рекламний дохід (DM-тріаж → дії за апрувом → оплата LiqPay → розвідка чатів).

Дві петлі, з яких складається весь бізнес:

```plantuml
@startuml
skinparam backgroundColor transparent
skinparam defaultTextAlignment center
rectangle "СТВОРЕННЯ ЦІННОСТІ\n(value creation)" as VC #e8f5e9 {
  usecase "16 стратегій\nparse → dedup → AI-generate → review" as gen
  usecase "publish\nTelegram / Meta / TikTok" as pub
  usecase "track\nвʼюхи, підписники, ROI" as trk
  gen --> pub --> trk
}
rectangle "ЗАХОПЛЕННЯ ЦІННОСТІ\n(value capture — агент-оператор)" as VD #fff3e0 {
  usecase "SP1 DM-тріаж" as sp1
  usecase "SP2 дії за апрувом" as sp2
  usecase "SP3 оплата (LiqPay)" as sp3
  usecase "SP4 розвідка чатів" as sp4
  sp4 --> sp1 --> sp2 --> sp3
}
trk --> sp1 : аудиторія\n= товар
sp3 --> pub : оплачений\nспонсорський пост
@enduml
```

## Структура документів

| Файл | Про що |
|---|---|
| [01-product-and-business.md](01-product-and-business.md) | Продукт, 16 стратегій, як робиться $, чому single-tenant |
| [02-architecture.md](02-architecture.md) | 3-app монорепо, модулі NestJS, ключові абстракції, потік публікації (+ PlantUML) |
| [03-data-and-queues.md](03-data-and-queues.md) | Схема БД (45 таблиць по 7 доменах), BullMQ/Redis vs cron, навантаження, **стеля «1 інстанс»** (+ PlantUML) |
| [04-agent-operator.md](04-agent-operator.md) | Монетизаційний агент SP1–SP4 детально (+ PlantUML sequence) |
| [05-strengths-weaknesses-risks.md](05-strengths-weaknesses-risks.md) | Чесний SWOT + що щойно закрили + дорожня карта |

## Ключові цифри (перевірені)

- **3** застосунки в монорепо · **~30** NestJS-модулів · **16** контент-стратегій
- **45** доменних таблиць у Postgres (+ `schema_migrations`), **41** міграція
- **4** BullMQ-черги (трекінг) + **~9** cron-джобів (@nestjs/schedule)
- **597** бекенд-тестів (0 фейлів) · **0** тестів на дашборді
- **1** підтримуваний інстанс automation-сервісу (архітектурна межа, не тимчасова)

## Як читати PlantUML

Діаграми вбудовані як ` ```plantuml ` блоки. У Cowork/Confluence/VS Code (плагін PlantUML) вони рендеряться напряму; або встав код у https://www.plantuml.com/plantuml.
