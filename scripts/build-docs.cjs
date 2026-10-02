// Regenerate the Word (.docx) copies of this project's reports from their .md files.
// Reports and their .docx copies live in docs/; images live in images/.
// The Mermaid "Technology and build map" is rendered to images/tech-build-map.png first,
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
const DOCS = path.join(ROOT, 'docs');
const PREFIX = fs.existsSync(path.join(DOCS, 'NoteVault_report1.md')) ? 'NoteVault_' : '';
const REPORTS = ['report1.md', 'project-report.md', 'Edits_made.md', 'Edits_today.md'].map((f) => path.join(DOCS, PREFIX + f));
const CHART_PNG = path.join(ROOT, 'images', 'tech-build-map.png');

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
  const source = REPORTS.find((f) => fs.existsSync(f));
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

/** Image links in the .md are relative to the .md's own folder, so pandoc resolves them from there. */
function toDocx(mdPath, docxName) {
  if (!fs.existsSync(mdPath)) return;
  const mdDir = path.dirname(mdPath);
  const img = path.relative(mdDir, CHART_PNG).replace(/\\/g, '/');
  const text = fs.readFileSync(mdPath, 'utf8').replace(/```mermaid\r?\n[\s\S]*?```/g, `![Technology and build map](${img})`);
  const tmp = path.join(mdDir, `.__docx_tmp_${path.basename(mdPath)}`);
  fs.writeFileSync(tmp, text);
  try {
    execFileSync(findPandoc(), [tmp, '-f', 'gfm+yaml_metadata_block', '-o', path.join(DOCS, docxName), '--resource-path', mdDir], { stdio: 'inherit' });
    console.log('docx: ', path.join('docs', docxName));
  } finally {
    fs.unlinkSync(tmp);
  }
}

renderChart();
for (const md of REPORTS) toDocx(md, path.basename(md).replace(/\.md$/, '.docx'));
toDocx(path.join(ROOT, 'README.md'), PREFIX + 'README.docx');
if (!PREFIX) toDocx(path.join(DOCS, 'project-report.md'), 'project-report.updated.docx');
