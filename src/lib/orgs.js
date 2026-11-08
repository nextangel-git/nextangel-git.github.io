// Единая палитра организаций на карте: ЖКС всегда первая (бренд-синий),
// остальные — по убыванию количества домов.
import competitors from '../data/competitors.json';
import houses from '../data/houses.json';

export const OURS_NAME = 'УК «Жилкомсервис»';
export const OURS_COUNT = houses.length;

const PALETTE = [
  '#e07b00', // оранжевый
  '#0f9d58', // зелёный
  '#8e24aa', // фиолетовый
  '#c62828', // красный
  '#00838f', // бирюзовый
  '#6d4c41', // коричневый
  '#d81b60', // розовый
  '#5e35b1', // индиго
  '#7cb342', // лайм
  '#546e7a', // серо-синий
];

export function getOrgLegend() {
  const counts = {};
  for (const c of competitors) counts[c.uk] = (counts[c.uk] || 0) + 1;
  const others = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .map(([name, count], i) => ({ name, count, color: PALETTE[i % PALETTE.length] }));
  return [{ name: OURS_NAME, count: OURS_COUNT, color: '#3856a3', ours: true }, ...others];
}

export function orgColor(name) {
  const found = getOrgLegend().find((o) => o.name === name);
  return found ? found.color : '#94a3b8';
}
