import { jsPDF } from 'jspdf';
import autoTableImport from 'jspdf-autotable';

// works whether the bundler hands us the function or the module object
const autoTable = typeof autoTableImport === 'function' ? autoTableImport : autoTableImport.default;

const dmy = (d) => { if (!d) return ''; const [y, m, day] = String(d).slice(0, 10).split('-'); return `${day}-${m}-${y}`; };
const nowIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);

/** Builds the transfer challan PDF. Returns the jsPDF document (caller saves it). */
export function makePdf(t, items) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 14;

  // Header
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(25, 103, 210);
  doc.text('UNIT TRANSFER CHALLAN', M, 18);
  doc.setFontSize(10); doc.setTextColor(60);
  doc.text(t.transfer_no, W - M, 18, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(120);
  doc.text('Propskart  |  Urban Pebbles', M, 24);
  doc.setDrawColor(25, 103, 210); doc.setLineWidth(0.6); doc.line(M, 27, W - M, 27);

  // Details block
  autoTable(doc, {
    startY: 31,
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 2.6, lineColor: [210, 214, 220], lineWidth: 0.2, textColor: 30 },
    columnStyles: {
      0: { fontStyle: 'bold', fillColor: [243, 246, 251], cellWidth: 32 },
      1: { cellWidth: 56 },
      2: { fontStyle: 'bold', fillColor: [243, 246, 251], cellWidth: 32 },
      3: { cellWidth: 'auto' },
    },
    body: [
      ['Transfer No', t.transfer_no, 'Date', dmy(t.transfer_date)],
      ['From Unit', t.from_unit, 'To Unit', t.to_unit],
      ['Vehicle', t.vehicle_type || '-', 'Vehicle No', t.vehicle_no || '-'],
      ['Driver', t.driver || '-', 'Note', t.note || '-'],
    ],
  });

  // Items
  const totalQty = items.reduce((s, i) => s + Number(i.quantity), 0);
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 8,
    theme: 'striped',
    headStyles: { fillColor: [25, 103, 210], textColor: 255, fontSize: 10 },
    footStyles: { fillColor: [243, 246, 251], textColor: 20, fontStyle: 'bold', fontSize: 10 },
    styles: { fontSize: 10, cellPadding: 2.4 },
    columnStyles: { 0: { cellWidth: 12, halign: 'center' }, 1: { cellWidth: 22 }, 3: { cellWidth: 24, halign: 'right' } },
    didParseCell: (d) => { if (d.section === 'head' && d.column.index === 3) d.cell.styles.halign = 'right'; },
    head: [['#', 'Code', 'Item', 'Qty']],
    body: items.map((i, n) => [n + 1, i.sno ?? '', i.product_name, Number(i.quantity)]),
    foot: [['', '', `Total (${items.length} item${items.length === 1 ? '' : 's'})`, totalQty]],
    showFoot: 'lastPage',
  });

  // Signatures
  let y = doc.lastAutoTable.finalY + 30;
  if (y > doc.internal.pageSize.getHeight() - 30) { doc.addPage(); y = 40; }
  doc.setDrawColor(90); doc.setLineWidth(0.3); doc.setFontSize(9); doc.setTextColor(70);
  const sig = [[M, `Dispatched by (${t.from_unit})`], [W / 2 - 25, 'Driver'], [W - M - 50, `Received by (${t.to_unit})`]];
  sig.forEach(([x, label]) => { doc.line(x, y, x + 50, y); doc.text(label, x, y + 5); });

  // Footer on every page
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8); doc.setTextColor(140);
    const H = doc.internal.pageSize.getHeight();
    doc.text(`Generated ${nowIST()} IST`, M, H - 8);
    doc.text(`Page ${p} of ${pages}`, W - M, H - 8, { align: 'right' });
  }
  return doc;
}
