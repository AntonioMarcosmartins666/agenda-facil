function partsInSaoPaulo(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
}

function part(parts: Intl.DateTimeFormatPart[], type: string) {
  return parts.find((item) => item.type === type)?.value ?? '';
}

export function saoPauloDateTime(date = new Date()) {
  const parts = partsInSaoPaulo(date);
  return {
    date: `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`,
    time: `${part(parts, 'hour')}:${part(parts, 'minute')}`,
  };
}

export function saoPauloDate(date = new Date()) {
  return saoPauloDateTime(date).date;
}
