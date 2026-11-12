// Конфиг коллекций админки ЖКС: файл данных + поля формы.
// type: text | textarea | number | url | checkbox
export const COLLECTIONS = {
  news: {
    label: 'Новости', file: 'news.json', singular: 'новость',
    fields: [
      { key: 'title', label: 'Заголовок', type: 'text', required: true },
      { key: 'desc', label: 'Анонс', type: 'textarea' },
      { key: 'date', label: 'Дата (ДД.ММ.ГГГГ)', type: 'text', required: true, placeholder: '09.11.2026' },
      { key: 'url', label: 'Ссылка (необязательно)', type: 'url' },
      { key: 'body', label: 'Полный текст (HTML)', type: 'textarea' },
    ],
    defaults: () => ({ date: new Date().toLocaleDateString('ru-RU'), id: Date.now() }),
    display: (x) => `${x.date || ''} — ${x.title}`,
  },
  documents: {
    label: 'Документы', file: 'documents.json', singular: 'документ',
    fields: [
      { key: 'name', label: 'Название', type: 'text', required: true },
      { key: 'cat', label: 'Категория', type: 'select', required: true, options: ['Отчёты по договору управления', 'Протоколы собраний', 'Бухгалтерская отчётность', 'Тарифы на коммунальные ресурсы', 'Сведения о выполняемых работах', 'Нормативно-правовые акты'] },
      { key: 'house', label: 'Дом (для протоколов собраний)', type: 'house' },
      { key: 'year', label: 'Год', type: 'number' },
      { key: 'url', label: 'Файл', type: 'file' },
    ],
    defaults: () => ({ ext: 'PDF', date: new Date().toLocaleDateString('ru-RU') }),
    display: (x) => `[${x.cat}] ${x.name}${x.house ? ` — ${x.house}` : ''}`,
  },
  houses: {
    label: 'Дома', file: 'houses.json', singular: 'дом',
    fields: [
      { key: 'street', label: 'Улица', type: 'street', required: true },
      { key: 'num', label: 'Номер дома', type: 'housenum', required: true },
    ],
    display: (x) => `ул. ${x.street}, ${x.num}`,
  },
  shutdowns: {
    label: 'Отключения', file: 'shutdowns.json', singular: 'отключение',
    fields: [
      { key: 'what', label: 'Что отключается', type: 'text', required: true, placeholder: 'Горячая вода' },
      { key: 'where', label: 'Где (адреса)', type: 'text', required: true, placeholder: 'ул. Юности, 1–19' },
      { key: 'from', label: 'С (когда)', type: 'text', placeholder: '12.11.2026 09:00' },
      { key: 'to', label: 'По (когда)', type: 'text', placeholder: '12.11.2026 18:00' },
      { key: 'reason', label: 'Причина', type: 'text' },
      { key: 'until', label: 'Показывать до (дата ГГГГ-ММ-ДД)', type: 'text', placeholder: '2026-11-12' },
      { key: 'active', label: 'Активно (показывать на главной)', type: 'checkbox' },
    ],
    defaults: () => ({ active: true }),
    display: (x) => `${x.what} — ${x.where}`,
  },
  faq: {
    label: 'Вопросы и ответы', file: 'faq.json', singular: 'вопрос',
    fields: [
      { key: 'q', label: 'Вопрос', type: 'text', required: true },
      { key: 'a', label: 'Ответ', type: 'textarea', required: true },
    ],
    display: (x) => x.q,
  },
  useful: {
    label: 'Полезное (статьи)', file: 'useful.json', singular: 'статья', dict: true,
    fields: [
      { key: 'title', label: 'Заголовок', type: 'text', required: true },
      { key: 'body', label: 'Текст (HTML)', type: 'textarea', required: true },
      { key: 'source', label: 'Источник (ссылка)', type: 'url' },
    ],
    display: (x) => x.title,
  },
  services: {
    label: 'Платные услуги', file: 'services.json', singular: 'услуга', nested: true,
    // services.json: [{ cat, items: [{ name, price, unit }] }]
    itemFields: [
      { key: 'name', label: 'Название услуги', type: 'text', required: true },
      { key: 'price', label: 'Цена, ₽ (пусто = «по запросу»)', type: 'number' },
      { key: 'unit', label: 'Единица', type: 'text', placeholder: 'шт / услуга / выезд' },
    ],
    display: (x) => x.name,
  },
  vk_posts: {
    label: 'Посты VK (авто)', file: 'vk_posts.json', singular: 'пост', readonly: true,
    fields: [],
    display: (x) => `${x.date || ''} — ${(x.text || '').slice(0, 60)}`,
  },
  requests: {
    label: 'Заявки с сайта', file: 'requests.json', singular: 'заявка', readonly: true,
    fields: [],
    display: (x) => `${x.date || ''} — ${x.fio || ''} — ${x.topic || ''}`,
  },
};
