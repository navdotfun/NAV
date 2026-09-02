import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  REPO_META, FILE_GROUPS, ARCHITECTURE_MD, AUDITS,
  TEST_GROUPS, TEST_TOTALS, CAMPAIGN_VOLUMES,
  type RepoFile,
} from "./data";

const TABS = ["readme", "source", "audits", "tests"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  readme: "README",
  source: "SOURCE",
  audits: "AUDITS",
  tests: "TESTS",
};

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Line-numbered read-only source pane. */
function CodePane({ file }: { file: RepoFile }) {
  const lines = useMemo(() => file.src.replace(/\n$/, "").split("\n"), [file.src]);
  return (
    <div className="repo-code" role="region" aria-label={`Source of ${file.path}`}>
      <div className="repo-code-head">
        <span className="px-label">{file.path}</span>
        <span className="repo-code-meta">
          {lines.length} lines · {(file.src.length / 1024).toFixed(1)} kB · {file.lang}
          {file.address ? (
            <>
              {" · "}
              <a
                href={`https://robinhoodchain.blockscout.com/address/${file.address}?tab=contract`}
                target="_blank" rel="noreferrer"
              >
                verified {short(file.address)}
              </a>
            </>
          ) : null}
        </span>
      </div>
      <div className="repo-code-scroll" tabIndex={0}>
        <pre>
          {lines.map((ln, i) => (
            <div className="repo-ln" key={i}>
              <span className="repo-ln-no" aria-hidden="true">{i + 1}</span>
              <span className="repo-ln-src">{ln === "" ? " " : ln}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function SourceView() {
  const first = FILE_GROUPS[0].files[1]; // NAVVault.sol as the opening file
  const [sel, setSel] = useState<RepoFile>(first);
  return (
    <div className="repo-source">
      <nav className="repo-tree" aria-label="Repository files">
        {FILE_GROUPS.map((g) => (
          <div key={g.dir} className="repo-tree-group">
            <div className="repo-tree-dir px-label">{g.dir}/</div>
            {g.files.map((f) => (
              <button
                key={f.path}
                type="button"
                className={`repo-tree-file ${sel.path === f.path && sel.src === f.src ? "active" : ""}`}
                onClick={() => setSel(f)}
                aria-current={sel.path === f.path ? "true" : undefined}
                title={f.note}
              >
                {f.path}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="repo-main">
        <p className="repo-filenote">{sel.note}</p>
        <CodePane file={sel} />
      </div>
    </div>
  );
}

function AuditsView() {
  const [sel, setSel] = useState(AUDITS[0]);
  return (
    <div className="repo-source">
      <nav className="repo-tree" aria-label="Audit reports">
        <div className="repo-tree-group">
          <div className="repo-tree-dir px-label">audits/</div>
          {AUDITS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`repo-tree-file ${sel.id === a.id ? "active" : ""}`}
              onClick={() => setSel(a)}
              aria-current={sel.id === a.id ? "true" : undefined}
              title={a.scope}
            >
              {a.title}
            </button>
          ))}
        </div>
      </nav>
      <div className="repo-main">
        <div className="docs-prose repo-report">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{sel.md}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function TestsView() {
  return (
    <div className="repo-tests">
      <div className="repo-stat-row">
        <div className="repo-stat">
          <div className="repo-stat-v">{TEST_TOTALS.functions}</div>
          <div className="px-label">test functions</div>
        </div>
        <div className="repo-stat">
          <div className="repo-stat-v">{TEST_TOTALS.invariants}</div>
          <div className="px-label">stateful invariants</div>
        </div>
        <div className="repo-stat">
          <div className="repo-stat-v">{TEST_TOTALS.files}</div>
          <div className="px-label">suite files</div>
        </div>
      </div>

      <p className="repo-filenote">
        Counts are taken from the suites at commit {REPO_META.commit} (one row per
        <code> *.t.sol</code> file; grouped where a fix campaign spans several files).
        Campaign volumes below are the randomized-execution totals from each engagement report.
      </p>

      {TEST_GROUPS.map((g) => (
        <div key={g.module} className="repo-test-group">
          <div className="repo-tree-dir px-label">test/{g.module === "core" ? "" : g.module + "/"}</div>
          <table className="repo-table">
            <thead>
              <tr><th>suite</th><th>kind</th><th className="num">tests</th></tr>
            </thead>
            <tbody>
              {g.suites.map((s) => (
                <tr key={s.file}>
                  <td className="mono">{s.file}</td>
                  <td>{s.kind}</td>
                  <td className="num">{s.tests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="repo-test-group">
        <div className="repo-tree-dir px-label">campaign volumes</div>
        <table className="repo-table">
          <thead>
            <tr><th>measure</th><th className="num">executions</th><th>engagement</th></tr>
          </thead>
          <tbody>
            {CAMPAIGN_VOLUMES.map((c) => (
              <tr key={c.label}>
                <td>{c.label}</td>
                <td className="num mono">{c.value}</td>
                <td>{c.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Repo() {
  const [tab, setTab] = useState<Tab>("readme");
  return (
    <section className="repo border hairline bg-white" aria-label="Protocol repository">
      <header className="repo-head">
        <div className="repo-title">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="repo-glyph">
            <path fill="currentColor" d="M3 1h8l2 2v12H3V1zm8 1H4v12h8V4h-2V2zM5.5 6h5v1h-5V6zm0 2.5h5v1h-5v-1zm0 2.5h3v1h-3v-1z"/>
          </svg>
          <span className="repo-name">{REPO_META.name}</span>
          <span className="repo-chip">{REPO_META.branch}</span>
          <span className="repo-chip mono">{REPO_META.commit}</span>
        </div>
        <div className="repo-facts px-label">
          <span>{REPO_META.commits} commits</span>
          <span>{REPO_META.network}</span>
          <span>{REPO_META.toolchain}</span>
          <span>snapshot {REPO_META.stamped}</span>
        </div>
      </header>

      <div className="repo-tabs" role="tablist" aria-label="Repository sections">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`repo-tab px-label ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="repo-body">
        {tab === "readme" && (
          <div className="docs-prose repo-report">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{ARCHITECTURE_MD}</ReactMarkdown>
          </div>
        )}
        {tab === "source" && <SourceView />}
        {tab === "audits" && <AuditsView />}
        {tab === "tests" && <TestsView />}
      </div>
    </section>
  );
}
