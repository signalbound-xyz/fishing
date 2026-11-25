/**
 * Season Hunt is the game's one competition in the navigation; the tournaments are retired from it, not removed.
 * These read the sources, because the pages need a browser to run: what they guard is that nobody deletes the way
 * to an old tournament prize while tidying the menu.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('tournaments, retired', () => {
  const header = src('./ui/header.ts');
  const app = src('./app.ts');
  const cupPage = src('./ui/cup.ts');
  const cup = src('./cup.ts');
  const hunt = src('./ui/hunt.ts');

  it('the top navigation has the Season Hunt and no Tournaments', () => {
    const nav = header.slice(header.indexOf("class: 'topnav'"));
    const links = nav.slice(0, nav.indexOf('\n'));
    expect(links).toContain("link('hunt', 'Season Hunt', '#/hunt')");
    expect(links).not.toContain('#/cup');
    expect(links).not.toMatch(/Tournaments/);
  });

  it('the tournaments page is still there, at the same address', () => {
    expect(app).toContain("location.hash === '#/cup'");
    expect(app).toContain('initCup(cupEl)');
    expect(cupPage).toContain('Legacy tournaments');
  });

  it('the Season Hunt page links to it', () => {
    expect(hunt).toMatch(/Legacy tournaments →', attrs: \{ href: '#\/cup' \}/);
  });

  it('a prize won in a tournament can still be claimed, and an unwon one taken back', () => {
    expect(cup).toMatch(/functionName: 'enter' \| 'cast' \| 'reel' \| 'claim' \| 'reclaim'/);
    expect(cupPage).toContain('cupOps.claim(c.id)');
    expect(cupPage).toContain('cupOps.reclaim(c.id)');
  });

  it('the client announces no tournament: it has no call that creates one', () => {
    for (const text of [cup, cupPage]) expect(text).not.toMatch(/functionName: 'create'/);
  });
});
