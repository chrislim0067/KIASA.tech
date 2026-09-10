import type { Metadata } from 'next';

import ProfileShell from '@/components/profile/ProfileShell';
import WorkerPairingPanel from '@/components/worker/WorkerPairingPanel';
import { requireCandidate } from '@/lib/candidate/session';

/**
 * /profile/worker — connect a computer of your own.
 *
 * The copy carries as much weight as the code on this page. A candidate is
 * being asked to run a program on their own machine and connect it to a
 * website, which is a reasonable thing to be cautious about — so the page says
 * plainly what it does, what it never asks for, and how to turn it off.
 *
 * What it must never imply: that KIASA needs a Claude API key, that it sees
 * their Claude account, or that anything applies to jobs on their behalf. None
 * of those is true, and the last one is not built at all.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect your computer | KIASA',
  robots: { index: false, follow: false },
};

export default async function WorkerPage() {
  const { user } = await requireCandidate();

  return (
    <ProfileShell
      title="Connect your computer"
      lede="Some work runs on your own machine, using the Claude you are already signed in to. KIASA never sees your Claude account."
      email={user.email ?? null}
      back
    >
      <div className="kprof__fieldset">
        <legend className="kprof__legend">How this works</legend>
        <p className="kprof__hint">
          You run a small program on your computer. It connects out to KIASA — nothing connects
          in, and you do not need to open any ports or change your router. It checks in
          periodically so this page can tell you it is running.
        </p>
        <p className="kprof__hint">
          When it needs Claude, it uses the Claude Max you are already logged into on that
          machine, through Anthropic&rsquo;s own command-line tool. <strong>KIASA never asks for a
          Claude API key, never sees your Claude login, and never signs in as you.</strong> If you
          are not signed in to Claude on that computer, that part simply does not run.
        </p>
        <p className="kprof__hint">
          It does not open employer websites and does not submit applications. That is not built,
          and this page will change before it is.
        </p>
      </div>

      <div className="kprof__fieldset">
        <legend className="kprof__legend">Status</legend>
        <WorkerPairingPanel />
      </div>

      <div className="kprof__fieldset">
        <legend className="kprof__legend">Turning it off</legend>
        <p className="kprof__hint">
          Revoking takes effect on the worker&rsquo;s next check-in, within about a minute, and it
          stops. The connection also expires on its own, so a computer you stop using disconnects
          itself. Pairing again issues a fresh connection and retires the old one.
        </p>
      </div>
    </ProfileShell>
  );
}
