import { Link } from "react-router-dom";
import { LogoMark, Wordmark } from "./Logo";

function ChainlinkMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0L9.798 1.266l-6 3.468L1.596 6v12l2.202 1.266 6.055 3.468L12.055 24l2.202-1.266 5.945-3.468L22.404 18V6l-2.202-1.266-6-3.468zM6 15.468V8.532l6-3.468 6 3.468v6.936l-6 3.468z" />
    </svg>
  );
}

function PythMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="104 64 312 392" fill="currentColor" aria-hidden="true">
      <path d="M303.4,228.5c0,20.7-16.7,37.5-37.4,37.5v37.5c41.3,0,74.7-33.5,74.7-74.9s-33.5-74.9-74.7-74.9c-13.6,0-26.4,3.6-37.4,10c-22.3,12.9-37.4,37.2-37.4,64.9v187.3l33.6,33.7l3.8,3.8V228.5c0-20.7,16.7-37.5,37.4-37.5S303.4,207.9,303.4,228.5z" />
      <path d="M266,78.7c-27.2,0-52.7,7.3-74.7,20.1c-14.1,8.1-26.7,18.5-37.4,30.7c-23.2,26.4-37.4,61.1-37.4,99.1v112.4l37.4,37.5V228.5c0-33.3,14.4-63.2,37.4-83.8c10.8-9.7,23.4-17.3,37.4-22.2c11.7-4.2,24.3-6.4,37.4-6.4c61.9,0,112.1,50.3,112.1,112.4S327.9,340.9,266,340.9v37.5c82.5,0,149.4-67.1,149.4-149.8S348.5,78.7,266,78.7z" />
    </svg>
  );
}

function RobinhoodMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M2.84 24h.53c.096 0 .192-.048.224-.128C7.591 13.696 11.94 8.656 14.67 5.638c.112-.128.064-.225-.096-.225h-4.88a.55.55 0 0 0-.45.225L5.746 9.972c-.514.642-.642 1.236-.642 2.086v4.43c-1.14 3.194-1.862 5.361-2.392 7.32-.032.125.016.192.129.192M20.447.646c-.754-.802-4.157-.834-5.73-.224a3 3 0 0 0-.786.465 41 41 0 0 0-3.323 3.178c-.112.113-.064.225.097.225h5.409c.497 0 .786.289.786.786v6.1c0 .16.128.208.225.064l3.258-4.254c.53-.69.69-.898.835-1.861.192-1.413.08-3.58-.77-4.479m-6.982 16.18 2.231-3.676a.7.7 0 0 0 .064-.29V6.73c0-.16-.112-.225-.224-.097-3.355 3.74-5.971 7.672-8.395 12.407-.06.12.016.225.16.177l5.009-1.54c.565-.174.882-.402 1.155-.852" />
    </svg>
  );
}

export function PoweredBy({ compact = false }: { compact?: boolean }) {
  const item =
    "flex items-center gap-1.5 no-underline transition-colors duration-150";
  return (
    <div className={compact ? "flex flex-wrap items-center gap-x-5 gap-y-2" : "flex flex-wrap items-center gap-x-6 gap-y-2.5"}>
      <span className="px-label text-[10.5px] tracking-[0.14em] opacity-70">POWERED BY</span>
      <a className={`${item} text-muted-dark hover:text-[#7ea2f0]`} href="https://chain.link" rel="noopener" aria-label="Chainlink">
        <ChainlinkMark size={compact ? 14 : 16} />
        <span className="text-[12.5px] font-medium">Chainlink</span>
      </a>
      <a className={`${item} text-muted-dark hover:text-[#cdb5ff]`} href="https://pyth.network" rel="noopener" aria-label="Pyth Network">
        <PythMark size={compact ? 15 : 17} />
        <span className="text-[12.5px] font-medium">Pyth</span>
      </a>
      <a className={`${item} text-muted-dark hover:text-crt`} href="https://robinhoodchain.blockscout.com" rel="noopener" aria-label="Robinhood Chain">
        <RobinhoodMark size={compact ? 14 : 16} />
        <span className="text-[12.5px] font-medium">Robinhood Chain</span>
      </a>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="bg-ink text-muted-dark pt-10 pb-8 md:pt-16 md:pb-10">
      <div className="wrap">
        <div className="grid gap-7 md:gap-10 md:grid-cols-[2fr_1fr_1fr] mb-8 md:mb-11">
          <div>
            <Link to="/" className="flex items-center gap-3 no-underline text-paper" aria-label="NAV home">
              <LogoMark size={30} field="#14191f" />
              <Wordmark color="#f5f7f8" />
            </Link>
            <p className="m-hide md:block text-sm max-w-[34em] mt-3.5">
              Net Asset Value, made fun. One token, every tokenized stock on Robinhood Chain,
              redeemable in-kind. No manager. No mandate. Just NAV.
            </p>
          </div>
          <div>
            <h4 className="px-label text-paper mb-3.5">PROTOCOL</h4>
            <ul className="grid gap-2 text-sm">
              <li><Link className="hover:text-crt" to="/#protocol">How it works</Link></li>
              <li><Link className="hover:text-crt" to="/#vault">Vault composition</Link></li>
              <li><Link className="hover:text-crt" to="/#tokenomics">Tokenomics</Link></li>
              <li><Link className="hover:text-crt" to="/#pit">Derivatives — F2 on the Floor</Link></li>
              <li><a className="hover:text-crt" href="/floor/">Floor terminal</a></li>
            </ul>
          </div>
          <div>
            <h4 className="px-label text-paper mb-3.5">COMMUNITY</h4>
            <ul className="grid gap-2 text-sm">
              <li><a className="hover:text-crt" href="https://x.com/navdotfun" rel="noopener">@navdotfun</a></li>
              <li><a className="hover:text-crt" href="https://nav.fun">nav.fun</a></li>
              <li><Link className="hover:text-crt" to="/docs">Docs</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-ink-3 pt-5 pb-4">
          <PoweredBy />
        </div>
        <div className="border-t border-ink-3 pt-5 text-[12.5px] flex flex-wrap justify-between gap-4">
          <span>© 2026 NAV. Market data and vault stats are read live from Robinhood Chain — no indexer, no backend.</span>
          <span className="m-hide md:inline">$NAV is an experiment, not investment advice. NAV may go down as well as up(dates).</span>
        </div>
      </div>
    </footer>
  );
}

export function FooterSlim() {
  return (
    <footer className="bg-ink text-muted-dark py-8">
      <div className="wrap grid gap-3">
        <PoweredBy compact />
        <div className="text-[12.5px] flex flex-wrap justify-between gap-4">
          <span>
            © 2026 NAV · <a className="hover:text-crt" href="https://x.com/navdotfun" rel="noopener">@navdotfun</a> ·{" "}
            <a className="hover:text-crt" href="https://nav.fun">nav.fun</a>
          </span>
          <span>
            <Link className="hover:text-crt" to="/docs">Docs</Link> · Live chain data · vault live · not investment advice.
          </span>
        </div>
      </div>
    </footer>
  );
}
