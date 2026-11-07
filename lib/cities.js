// Города карты: границы для серверных проверок «точка внутри нашего города».
// Новый город — одна строка здесь (и файл города в index.html). Астана не меняется.
export const CITY_BOXES = [
  { id: 'astana', w: 70.95, s: 50.85, e: 71.95, n: 51.40 },
  { id: 'oral',   w: 51.15, s: 51.05, e: 51.60, n: 51.38 },   // Орал
];
// m — запас в градусах (для «Своих на карте»: дачи, трасса)
export const inCities = (lat, lng, m = 0) => CITY_BOXES.some(b => lat > b.s - m && lat < b.n + m && lng > b.w - m && lng < b.e + m);
export const cityOf = (lat, lng) => (CITY_BOXES.find(b => lat > b.s && lat < b.n && lng > b.w && lng < b.e) || {}).id || null;
