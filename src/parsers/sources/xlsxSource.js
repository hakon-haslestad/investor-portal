const XLSX = require('xlsx');

function createXlsxSource(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  return {
    type: 'xlsx',
    getSheet(name) {
      const ws = wb.Sheets[name];
      if (!ws) return [];
      return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    },
  };
}

module.exports = { createXlsxSource };
