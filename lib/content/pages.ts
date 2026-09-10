import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { HeadData } from '@/lib/metadata';

export interface ContentPage extends HeadData {
  stylesheets: string[];
  bodyClass: string;
  features: string[];
  html: string;
}

export interface ContentIndexEntry {
  slug: string;
  id: string;
  lang: string;
  title: string;
  stylesheets: string[];
  features: string[];
}

const ROOT = path.join(process.cwd(), 'content');

export function getContentIndex(): ContentIndexEntry[] {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'pages', '_index.json'), 'utf8')) as ContentIndexEntry[];
}

export function getContentPage(slug: string): ContentPage | null {
  const id = slug === '' ? 'index' : slug.replace(/\//g, '__');
  const file = path.join(ROOT, 'pages', `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ContentPage;
}

export function getExperienceHead(slug: string): HeadData {
  const id = slug === '' ? 'index' : slug.replace(/\//g, '__');
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'experience', `${id}.json`), 'utf8')) as HeadData;
}
