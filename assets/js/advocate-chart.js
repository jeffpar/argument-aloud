/**
 * Renders a horizontal bar chart of advocates over time.
 *
 * @param {string} canvasId   - ID of the <canvas> element to render into
 * @param {string} dataUrl    - URL of the advocates JSON file to fetch
 * @param {string} collection - Collection ID used when building nav links (e.g. 'top_advocates')
 * @param {object} options    - Optional: { limit: N } to cap the number of advocates shown
 */
async function renderAdvocateChart(canvasId, dataUrl, collection, { limit = null } = {}) {
  const res = await fetch(dataUrl);
  let advocates = await res.json();

  // Sort by cases descending so the most-argued advocates appear at the top
  advocates = [...advocates].sort((a, b) => b.cases - a.cases);
  if (limit != null) advocates = advocates.slice(0, limit);

  function toDecimalYear(dateStr) {
    const [y, m] = dateStr.split('-').map(Number);
    return y + (m - 1) / 12;
  }

  function titleCase(s) {
    return s.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase());
  }

  function lastName(name) {
    const cleaned = name.trim().replace(/,\s*(II|III|IV|JR\.|SR\.)$/i, '');
    const parts = cleaned.trim().split(/\s+/);
    return parts[parts.length - 1];
  }

  const allFirsts = advocates.map(a => toDecimalYear(a.dateFirst));
  const allLasts  = advocates.map(a => toDecimalYear(a.dateLast));
  const minYear   = Math.floor(Math.min(...allFirsts) / 10) * 10;
  const maxYear   = Math.ceil(Math.max(...allLasts)   / 10) * 10;
  const maxCases  = Math.max(...advocates.map(a => a.cases));

  // Size the container to fit all rows at a comfortable height
  const rowPx = 14;
  const axisH = 50;
  const canvas = document.getElementById(canvasId);
  canvas.parentElement.style.height = (advocates.length * rowPx + axisH) + 'px';

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: advocates.map(a => lastName(a.name)),
      datasets: [{
        data: advocates.map(a => [toDecimalYear(a.dateFirst), toDecimalYear(a.dateLast)]),
        backgroundColor: advocates.map(a => {
          const ratio = a.cases / maxCases;
          return `hsl(210,65%,${Math.round(65 - ratio * 30)}%)`;
        }),
        borderWidth: 0,
        borderSkipped: false,
        barThickness: 10,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      onClick(event, elements) {
        if (elements.length > 0)
          window.top.location.href = `/courts/ussc/?collection=${collection}&id=${advocates[elements[0].index].id}`;
      },
      onHover(event, elements) {
        event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
      },
      scales: {
        x: {
          min: minYear,
          max: maxYear,
          position: 'top',
          ticks: { stepSize: 10, callback: v => String(Math.round(v)), color: '#555' },
          grid: { color: 'rgba(0,0,0,0.08)' },
        },
        y: {
          ticks: { font: { size: 9 }, color: '#555' },
          grid: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => titleCase(advocates[items[0].dataIndex].name),
            label: item => {
              const a = advocates[item.dataIndex];
              return `${a.dateFirst.slice(0, 4)}–${a.dateLast.slice(0, 4)}  ·  ${a.cases} arguments`;
            },
          },
        },
      },
    },
  });
}
