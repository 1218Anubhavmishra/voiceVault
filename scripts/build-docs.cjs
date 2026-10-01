// Regenerate the Word (.docx) copies of this project's reports from their .md files.
// The Mermaid "Technology and build map" is rendered to report-assets/tech-build-map.png first,
// because Word can't display Mermaid code.
//
// Usage (from the project root):  node scripts/build-docs.cjs
// Needs: pandoc (winget install JohnMacFarlane.Pandoc) and Microsoft Edge or Chrome.
// The first run installs @mermaid-js/mermaid-cli into %TEMP%\vv-mermaid-cli.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = fs.existsSync(path.join(ROOT, 'NoteVault_report1.md')) ? 'NoteVault_' : '';
const REPORTS = ['report1.md', 'project-report.md', 'Edits_made.md', 'Edits_today.md'].map((f) => PREFIX + f);
const CHART_PNG = path.join(ROOT, 'report-assets', 'tech-build-map.png');

function findPandoc() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Pandoc', 'pandoc.exe');
  return fs.existsSync(local) ? local : 'pandoc';
}

function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Install Microsoft Edge or Chrome to render the chart.');
  return found;
}

function renderChart() {
  const source = REPORTS.map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f));
  const match = fs.readFileSync(source, 'utf8').match(/```mermaid\r?\n([\s\S]*?)```/);
  if (!match) return false;

  const tool = path.join(os.tmpdir(), 'vv-mermaid-cli');
  const mmdc = path.join(tool, 'node_modules', '@mermaid-js', 'mermaid-cli', 'src', 'cli.js');
  if (!fs.existsSync(mmdc)) {
    fs.mkdirSync(tool, { recursive: true });
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    execFileSync(process.execPath, [npmCli, 'install', '--prefix', tool, '@mermaid-js/mermaid-cli'], {
      stdio: 'inherit',
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' },
    });
  }
  const mmd = path.join(tool, 'chart.mmd');
  const cfg = path.join(tool, 'puppeteer.json');
  fs.writeFileSync(mmd, match[1]);
  fs.writeFileSync(cfg, JSON.stringify({ executablePath: findBrowser() }));
  fs.mkdirSync(path.dirname(CHART_PNG), { recursive: true });
  execFileSync(process.execPath, [mmdc, '-i', mmd, '-o', CHART_PNG, '-p', cfg, '--size', '2400', '-s', '2', '-b', 'white', '-q'], {
    stdio: 'inherit',
  });
  console.log('chart:', path.relative(ROOT, CHART_PNG));
  return true;
}

function toDocx(mdName, docxName) {
  const mdPath = path.join(ROOT, mdName);
  if (!fs.existsSync(mdPath)) return;
  const img = path.relative(ROOT, CHART_PNG).replace(/\\/g, '/');
  const text = fs.readFileSync(mdPath, 'utf8').replace(/```mermaid\r?\n[\s\S]*?```/g, `![Technology and build map](${img})`);
  const tmp = path.join(ROOT, `.__docx_tmp_${mdName}`);
  fs.writeFileSync(tmp, text);
  try {
    execFileSync(findPandoc(), [tmp, '-f', 'gfm+yaml_metadata_block', '-o', path.join(ROOT, docxName), '--resource-path', ROOT], { stdio: 'inherit' });
    console.log('docx: ', docxName);
  } finally {
    fs.unlinkSync(tmp);
  }
}

renderChart();
for (const md of REPORTS) toDocx(md, md.replace(/\.md$/, '.docx'));
toDocx('README.md', PREFIX + 'README.docx');
if (!PREFIX) toDocx('project-report.md', 'project-report.updated.docx');
