import type { NotificationType, Template } from './catalog';

/**
 * Ukrainian text of every catalog row. The table is exhaustive on purpose: a new row in `catalog.ts` does not compile
 * until it has its translation here, and a test checks that both languages use the same placeholders (AS-80, AS-87).
 * Placeholders are `{{name}}`, as in the English templates.
 */
export const UK_TEMPLATES: Record<NotificationType, Template> = {
  'account.welcome': {
    title: 'Ласкаво просимо',
    body: 'Ваш обліковий запис готовий. Переглядайте магазини та дропи, коли зручно.',
    emailSubject: 'Ласкаво просимо на маркетплейс',
  },
  'security.registration_attempt': {
    title: 'Хтось спробував зареєструватися з вашою е-поштою',
    body: 'Якщо це були ви, просто увійдіть. Якщо ні, нічого робити не треба: ваш обліковий запис у безпеці.',
    emailSubject: 'Хтось спробував зареєструватися з вашою е-поштою',
  },
  'security.password_changed': {
    title: 'Ваш пароль змінено',
    body: 'Якщо це були не ви, негайно скиньте пароль і зверніться до підтримки.',
    emailSubject: 'Ваш пароль змінено',
  },
  'security.password_reset': {
    title: 'Скидання пароля',
    body: 'Скористайтеся цим посиланням, щоб обрати новий пароль: {{url}}\nВоно спрацює один раз і діє приблизно {{minutes}} хв. Якщо ви цього не просили, проігноруйте лист.',
    emailSubject: 'Скидання пароля',
    emailHtml:
      '<p>Скористайтеся цим посиланням, щоб обрати новий пароль:</p><p><a href="{{url}}">Скинути пароль</a></p><p>Воно спрацює один раз і діє приблизно {{minutes}} хв. Якщо ви цього не просили, проігноруйте лист.</p>',
  },
  'security.mfa_enabled': {
    title: 'Двоетапний вхід увімкнено',
    body: 'Для вашого облікового запису увімкнено двоетапну перевірку.',
    emailSubject: 'Двоетапний вхід увімкнено',
  },
  'security.mfa_disabled': {
    title: 'Двоетапний вхід вимкнено',
    body: 'Двоетапну перевірку для вашого облікового запису вимкнено ({{reason}}). Якщо це були не ви, негайно захистіть обліковий запис.',
    emailSubject: 'Двоетапний вхід вимкнено',
  },
  'security.recovery_code_used': {
    title: 'Використано код відновлення',
    body: 'Код відновлення використано для входу у ваш обліковий запис. Залишилось кодів: {{remaining}}.',
    emailSubject: 'Використано код відновлення',
  },
  'security.recovery_codes_regenerated': {
    title: 'Випущено нові коди відновлення',
    body: 'Попередні коди відновлення більше не діють.',
    emailSubject: 'Випущено нові коди відновлення',
  },
  'security.sign_in_method_added': {
    title: 'Додано спосіб входу',
    body: '{{provider}} підключено до вашого облікового запису.',
    emailSubject: 'Додано спосіб входу',
  },
  'security.sign_in_method_removed': {
    title: 'Видалено спосіб входу',
    body: '{{provider}} відключено від вашого облікового запису.',
    emailSubject: 'Видалено спосіб входу',
  },
  'security.phone_verification': {
    title: 'Ваш код підтвердження',
    body: 'Ваш код підтвердження: {{code}}. Він діє 10 хвилин.',
  },
  'shop.invite': {
    title: 'Вас запрошують до магазину {{shopName}}',
    body: 'Вас запросили приєднатися до магазину {{shopName}} з роллю {{role}}: {{url}}',
    emailSubject: 'Запрошення до магазину {{shopName}}',
    emailHtml:
      '<p>Вас запросили приєднатися до магазину <b>{{shopName}}</b> з роллю {{role}}.</p><p><a href="{{url}}">Прийняти запрошення</a></p>',
  },
  'shop.offboarding_started': {
    title: 'Ваш магазин закривається',
    body: 'Магазин буде видалено {{purgeAt}}. До цього часу закриття можна скасувати.',
    emailSubject: 'Ваш магазин закривається',
  },
  'shop.offboarding_cancelled': {
    title: 'Закриття магазину скасовано',
    body: 'Ваш магазин залишається відкритим.',
    emailSubject: 'Закриття магазину скасовано',
  },
  'shop.verified': {
    title: 'Ваш магазин підтверджено',
    body: 'Тепер ви можете продавати та отримувати виплати.',
    emailSubject: 'Ваш магазин підтверджено',
  },
  'shop.rejected': {
    title: 'Заявку магазину відхилено',
    body: 'Причина: {{reasonCode}}. Перегляньте деталі та подайте заявку знову.',
    emailSubject: 'Заявку магазину відхилено',
  },
  'shop.document_rejected': {
    title: 'Документ відхилено',
    body: 'Ваш документ ({{kind}}) відхилено: {{reason}}. Завантажте його ще раз.',
    emailSubject: 'Документ відхилено',
  },
  'shop.order_received': {
    title: 'Нове замовлення',
    body: 'Ви отримали замовлення на суму {{subtotal}}.',
  },
  'shop.flash_sale_sold_out': {
    title: 'Ваш дроп розпродано',
    body: 'Усі одиниці вашого обмеженого дропу продано.',
  },
  'shop.flash_sale_start_failed': {
    title: 'Дроп не вдалося запустити',
    body: 'Дроп не стартував ({{reason}}). З нього нічого не продано; перевірте залишок і заплануйте його знову.',
    emailSubject: 'Дроп не вдалося запустити',
  },
  'order.confirmed': {
    title: 'Замовлення підтверджено',
    body: 'Ми отримали оплату {{total}}. Замовлення {{orderShort}} готується.',
    emailSubject: 'Ваше замовлення {{orderShort}} підтверджено',
    emailHtml:
      '<h1>Дякуємо за замовлення!</h1><p>Оплата <b>{{total}}</b> отримана.</p><p><a href="{{url}}">Переглянути {{orderShort}}</a></p>',
  },
  'order.cancelled': {
    title: 'Замовлення скасовано',
    body: 'Замовлення {{orderShort}} скасовано.',
    emailSubject: 'Замовлення {{orderShort}} скасовано',
  },
  'order.refunded': {
    title: 'Кошти повернуто',
    body: 'Ми повернули {{amount}} за замовлення {{orderShort}}.',
    emailSubject: 'Повернення коштів за замовлення {{orderShort}}',
  },
  'order.shipped': {
    title: 'Ваше замовлення в дорозі',
    body: 'Замовлення {{orderShort}} відправлено. Трекінг: {{trackingCode}}',
    emailSubject: 'Замовлення {{orderShort}} відправлено',
  },
  'order.delivered': {
    title: 'Замовлення доставлено',
    body: 'Замовлення {{orderShort}} доставлено.',
  },
  'payment.failed': {
    title: 'Платіж не пройшов',
    body: 'Оплата {{amount}} за замовлення {{orderShort}} не пройшла. Спробуйте інший спосіб оплати.',
    emailSubject: 'Платіж за замовлення {{orderShort}} не пройшов',
  },
  'delivery.picked_up': {
    title: 'Передано в доставку',
    body: 'Кур’єр забрав замовлення {{orderShort}}.',
  },
  'delivery.cancelled': {
    title: 'Доставку скасовано',
    body: 'Доставку замовлення {{orderShort}} скасовано.',
  },
  'auction.outbid': {
    title: 'Вашу ставку перебили',
    body: 'Нова ставка {{price}}. Встигніть зробити свою.',
  },
  'auction.won': {
    title: 'Ви виграли аукціон!',
    body: 'Переможна ставка: {{price}}. Оформіть покупку, щоб забрати лот.',
    emailSubject: 'Ви виграли — завершіть покупку',
  },
  'auction.second_chance': {
    title: 'Другий шанс',
    body: 'Переможець не сплатив. Ви ще можете купити лот за {{price}} до {{expiresAt}}.',
    emailSubject: 'Другий шанс купити',
  },
  'auction.sold': {
    title: 'Аукціон завершено продажем',
    body: 'Ваш аукціон завершився продажем за {{price}}.',
    emailSubject: 'Ваш аукціон завершився продажем',
  },
  'billing.payment_failed': {
    title: 'Платіж не пройшов',
    body: 'Нам не вдалося списати кошти з вашої картки (спроба {{attempt}}). Оновіть спосіб оплати, щоб зберегти план.',
    emailSubject: 'Потрібна дія: платіж не пройшов',
  },
  'billing.access_withdrawn': {
    title: 'Доступ до плану припинено',
    body: 'Ми не змогли отримати оплату після спроб: {{attempt}}, тому платні функції вимкнено. Оновіть спосіб оплати, щоб їх повернути.',
    emailSubject: 'Доступ до плану припинено',
  },
  'billing.receipt': {
    title: 'Платіж отримано',
    body: 'Ми отримали {{total}}. Дякуємо.',
    emailSubject: 'Ваша квитанція',
  },
  'payout.paid': {
    title: 'Виплату надіслано',
    body: 'Виплату {{amount}} надіслано на ваш банківський рахунок.',
    emailSubject: 'Виплату надіслано',
  },
  'payout.failed': {
    title: 'Виплата не вдалася',
    body: 'Виплата {{amount}} не пройшла. Перевірте банківські реквізити.',
    emailSubject: 'Виплата не вдалася',
  },
  'booking.confirmed': {
    title: 'Бронювання підтверджено',
    body: 'Ваше бронювання місць ({{seats}}) підтверджено.',
    emailSubject: 'Бронювання підтверджено',
  },
  'chat.message': {
    title: 'Нове повідомлення: {{channelTitle}}',
    body: '{{preview}}',
    emailSubject: 'Нове повідомлення: {{channelTitle}}',
  },
  'discussion.reply': {
    title: 'Нова відповідь на ваш коментар',
    body: '{{preview}}',
  },
  'discussion.comment': {
    title: 'Новий коментар до вашого допису',
    body: '{{preview}}',
  },
  'developers.webhook_endpoint_disabled': {
    title: 'Вебхук-ендпоінт вимкнено',
    body: 'Доставки на {{host}} не вдавалися з {{failingSince}}, тому ендпоінт вимкнено. Виправте його та ввімкніть знову (пропущені події можна відтворити).',
    emailSubject: 'Потрібна дія: вебхук-ендпоінт вимкнено',
  },
  'insights.competitor_price_drop': {
    title: 'Конкурент знизив ціну: {{product}}',
    body: '{{host}} тепер продає за {{competitorPrice}} (ваша ціна: {{yourPrice}}).',
    emailSubject: 'Сповіщення про ціну: {{product}}',
  },
  'marketing.followed_shop_update': {
    title: 'Новини від магазину, на який ви підписані',
    body: 'Магазин, на який ви підписані, опублікував щось нове.',
  },
};
