import type { Metadata } from 'next';
import LegacyPage from '@/components/legacy/LegacyPage';
import { buildMetadata, resolveKey } from '@/lib/pages';

const SEGMENT = "service";
const PARAM = "s";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function pick(sp: Record<string, string | string[] | undefined>): string {
  const raw = sp[PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return resolveKey(SEGMENT, value);
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  return buildMetadata(pick(await searchParams));
}

export default async function Page({ searchParams }: Props) {
  return <LegacyPage pageKey={pick(await searchParams)} />;
}
