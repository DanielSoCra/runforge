export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auto-Claude Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #c9d1d9; font-family: 'Courier New', Courier, monospace; padding: 24px; }
  h1 { font-size: 1.4rem; color: #58a6ff; margin-bottom: 20px; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 20px; min-width: 160px; }
  .card-label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .card-value { font-size: 1.6rem; font-weight: bold; color: #e6edf3; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; }
  .badge-green { background: #1a4731; color: #3fb950; }
  .badge-yellow { background: #3d2b00; color: #d29922; }
  .badge-red { background: #3d1c1c; color: #f85149; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
  th { background: #21262d; color: #8b949e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 10px 14px; text-align: left; }
  td { padding: 10px 14px; border-top: 1px solid #21262d; font-size: 0.85rem; }
  tr:hover td { background: #1c2128; }
  .section-title { font-size: 0.9rem; color: #8b949e; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  #last-updated { font-size: 0.75rem; color: #484f58; margin-top: 16px; }
</style>
</head>
<body>
<h1>Auto-Claude Dashboard</h1>
<div class="cards" id="cards">
  <div class="card"><div class="card-label">Status</div><div class="card-value" id="card-status">—</div></div>
  <div class="card"><div class="card-label">Active Runs</div><div class="card-value" id="card-active">—</div></div>
  <div class="card"><div class="card-label">Daily Cost</div><div class="card-value" id="card-cost">—</div></div>
  <div class="card"><div class="card-label">Uptime</div><div class="card-value" id="card-uptime">—</div></div>
</div>
<div class="section-title">Recent Runs</div>
<table id="runs-table">
  <thead>
    <tr id="runs-header"></tr>
  </thead>
  <tbody id="runs-body"></tbody>
</table>
<div id="last-updated"></div>
<script>
(function () {
  'use strict';

  function addRow(tbody, cells) {
    var tr = document.createElement('tr');
    for (var i = 0; i < cells.length; i++) {
      var td = document.createElement('td');
      td.textContent = cells[i];
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  function makeBadge(text, cls) {
    var span = document.createElement('span');
    span.className = 'badge ' + cls;
    span.textContent = text;
    return span;
  }

  function formatUptime(seconds) {
    if (typeof seconds !== 'number') return '—';
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    return h + 'h ' + m + 'm ' + s + 's';
  }

  function updateStatus(data) {
    var statusEl = document.getElementById('card-status');
    var activeEl = document.getElementById('card-active');
    var costEl = document.getElementById('card-cost');
    var uptimeEl = document.getElementById('card-uptime');

    // Clear previous children safely
    while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);

    var paused = data && data.paused;
    var badge = makeBadge(paused ? 'Paused' : 'Running', paused ? 'badge-yellow' : 'badge-green');
    statusEl.appendChild(badge);

    activeEl.textContent = data && data.activeRuns != null ? String(data.activeRuns) : '—';
    costEl.textContent = data && data.dailyCost != null ? '$' + Number(data.dailyCost).toFixed(2) : '—';
    uptimeEl.textContent = data && data.uptime != null ? formatUptime(data.uptime) : '—';
  }

  function updateRuns(runs) {
    var header = document.getElementById('runs-header');
    var tbody = document.getElementById('runs-body');

    // Build header if empty
    if (!header.firstChild) {
      var cols = ['Issue', 'Outcome', 'Variant', 'Cost', 'Started', 'Completed'];
      for (var i = 0; i < cols.length; i++) {
        var th = document.createElement('th');
        th.textContent = cols[i];
        header.appendChild(th);
      }
    }

    // Clear existing rows
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    if (!Array.isArray(runs) || runs.length === 0) {
      addRow(tbody, ['No runs yet', '', '', '', '', '']);
      return;
    }

    // Show latest 20
    var slice = runs.slice(-20).reverse();
    for (var j = 0; j < slice.length; j++) {
      var r = slice[j];
      addRow(tbody, [
        '#' + r.issueNumber,
        r.outcome || '—',
        r.variant || '—',
        r.totalCost != null ? '$' + Number(r.totalCost).toFixed(3) : '—',
        r.startedAt ? r.startedAt.replace('T', ' ').slice(0, 19) : '—',
        r.completedAt ? r.completedAt.replace('T', ' ').slice(0, 19) : '—',
      ]);
    }
  }

  function tick() {
    fetch('/status')
      .then(function (r) { return r.json(); })
      .then(updateStatus)
      .catch(function () { updateStatus(null); });

    fetch('/api/runs')
      .then(function (r) { return r.json(); })
      .then(updateRuns)
      .catch(function () { updateRuns([]); });

    var el = document.getElementById('last-updated');
    el.textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  }

  tick();
  setInterval(tick, 5000);
}());
</script>
</body>
</html>`;
}
