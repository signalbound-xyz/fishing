/** Fish collection: the permanent encyclopedia, grouped by location. */
import { LOCATIONS, SPECIES, special } from '../../game/content';
import { TIERS, allMastery, masterySummary, percent, type LocationMastery, type SpeciesMastery, type TierId } from '../../game/mastery';
import { achievements, collectorStats, isUnlocked, locationProgress, unlockText } from '../../game/progress';
import type { Save } from '../../game/types';
import { RARITY_CLASS } from '../../i18n';
import { fmtWeight, h, icon, mount, segBar, sigOf } from '../../ui/dom';
import { toast } from '../../ui/toast';
import { fishArt } from '../fishSprite';
import { ops } from '../ops';
import { getSave, rev } from '../state';
import { pearl, rarityTag } from './fmt';
import { masteryBadge } from './masteryBadge';

export function initCollection(host: HTMLElement): () => void {
  return mount(host, () => sigOf(rev()), render);
}

export function claimButton(id: string, reward: number): HTMLElement {
  return h('button', {
    class: 'btn btn-primary btn-sm',
    text: `Claim ${pearl(reward)} PEARL`,
    onclick: () => {
      void ops.claimAchievement(id).then((got) => got !== undefined && toast(`+${pearl(got)} PEARL`, 'ok'));
    },
  });
}

/** What a species still owes the tier its water is working on, as the line under its card. */
function requirement(m: SpeciesMastery | undefined, tier: TierId | null): HTMLElement | null {
  if (!m) return h('span', { class: 'item-req muted', text: 'bonus: not part of mastery' });
  if (tier === null) return h('span', { class: 'item-req done', text: 'mastered' });
  if (tier === 'explorer') return h('span', { class: `item-req${m.explorer.done ? ' done' : ''}`, text: m.explorer.done ? 'discovered' : 'to discover' });
  if (tier === 'angler') return h('span', { class: `item-req${m.angler.done ? ' done' : ''}`, text: `${m.angler.have}/${m.angler.need} landed` });
  if (!m.master) return h('span', { class: 'item-req done', text: 'no trophy asked' });
  return h('span', { class: `item-req${m.master.done ? ' done' : ''}`, text: m.master.done ? `trophy ${fmtWeight(m.master.need)}+` : `trophy from ${fmtWeight(m.master.need)}` });
}

/** All three requirements of a species, for the card's tooltip. */
function requirementsTitle(m: SpeciesMastery): string {
  const mark = (done: boolean): string => (done ? 'done' : 'to do');
  return [
    `Explorer: discover it (${mark(m.explorer.done)})`,
    `Experienced Angler: land ${m.angler.need} (${m.angler.have}/${m.angler.need})`,
    m.master ? `Master: a personal best of ${fmtWeight(m.master.need)} or more (${mark(m.master.done)})` : 'Master: no trophy asked of a fish this rare',
  ].join('\n');
}

function speciesCard(s: Save, id: number, isSpecial: boolean, mastery: LocationMastery): HTMLElement {
  const sp = SPECIES[id];
  const e = s.dex[id];
  const m = mastery.species.find((x) => x.speciesId === id);
  const req = requirement(m, mastery.current);
  if (!e) {
    return h(
      'div',
      { class: `item dex unknown ${RARITY_CLASS[sp.rarity]}`, title: isSpecial ? 'A special fish. Extremely rare.' : sp.hidden ? 'A hidden species. Very rare.' : `Not discovered yet${m ? `\n${requirementsTitle(m)}` : ''}` },
      fishArt(id, { silhouette: true }),
      h('span', { class: 'item-name', text: '???' }),
      h('span', { class: 'item-tags' }, rarityTag(sp.rarity)),
      h('span', { class: 'item-meta muted', text: isSpecial ? 'special' : sp.hidden ? 'hidden' : 'undiscovered' }),
      req,
    );
  }
  return h(
    'div',
    { class: `item dex ${RARITY_CLASS[sp.rarity]}`, title: `${fmtWeight(sp.minWeight)} – ${fmtWeight(sp.maxWeight)} · base price ${pearl(sp.basePrice)} PEARL${m ? `\n${requirementsTitle(m)}` : ''}` },
    fishArt(id),
    h('span', { class: 'item-name', text: sp.name }),
    h('span', { class: 'item-tags' }, rarityTag(sp.rarity)),
    h('span', { class: 'item-meta' }, h('span', { text: `×${e.count}` }), h('span', { text: `best ${fmtWeight(e.best)}` })),
    req,
  );
}

const sectionId = (locationId: number): string => `dex-loc-${locationId}`;

/** All eight waters at a glance: a badge each, and the rank they add up to. */
function masteryOverview(all: LocationMastery[]): HTMLElement {
  const sum = masterySummary(all);
  return h(
    'section',
    { class: 'mastery-sum' },
    h(
      'div',
      { class: 'mastery-sum-head' },
      h('h3', { text: 'Water mastery' }),
      h('span', { class: `badge${sum.tiers ? ' badge-on' : ''}`, text: sum.title }),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted small', text: `${sum.tiers}/${sum.tiersTotal} tiers` }),
    ),
    h(
      'div',
      { class: 'mastery-row' },
      all.map((m) => {
        const loc = LOCATIONS[m.locationId];
        const tier = m.level > 0 ? TIERS[m.level - 1].name : 'not started';
        return h(
          'button',
          {
            class: `mastery-chip lvl-${m.level}`,
            title: `${loc.name}: ${tier}${m.current ? ` · ${percent(m.progress, false)}% of ${TIERS[m.level].name}` : ''}`,
            attrs: { type: 'button' },
            onclick: () => document.getElementById(sectionId(loc.id))?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }),
          },
          masteryBadge(loc.id, m.level, 2),
          h('span', { class: 'mastery-chip-name', text: loc.name }),
        );
      }),
    ),
    h(
      'p',
      { class: 'muted small' },
      `Explorer in ${sum.explorer}, Experienced Angler in ${sum.angler}, Master in ${sum.master} of ${sum.locations} waters. `,
      'Mastery is read from this encyclopedia, so every fish you have ever landed counts, the sold ones too. It is a badge: no XP, PEARL or energy comes with it.',
    ),
  );
}

/** One water's mastery: its badge, the tier being worked on with a bar, and the three tiers as a row of steps. */
function masteryBlock(m: LocationMastery): HTMLElement {
  const now = m.current ? TIERS[m.level] : null;
  const pct = percent(m.progress, m.current === null);
  return h(
    'div',
    { class: `mastery lvl-${m.level}` },
    masteryBadge(m.locationId, m.level, 3),
    h(
      'div',
      { class: 'mastery-body' },
      h(
        'div',
        { class: 'mastery-line' },
        h('b', { text: m.level > 0 ? TIERS[m.level - 1].name : 'No mastery yet' }),
        h('span', { class: 'muted small', text: now ? `next: ${now.name}` : 'every tier complete' }),
        h('div', { class: 'spacer' }),
        h('span', { class: 'mastery-pct', text: `${pct}%` }),
      ),
      segBar(pct, 100, 20, 'mastery-bar'),
      h(
        'ol',
        { class: 'mastery-tiers' },
        m.tiers.map((t, i) =>
          h(
            'li',
            { class: t.done ? 'done' : i === m.level ? 'now' : '', title: TIERS[i].rule },
            h('span', { class: 'mastery-step', text: t.done ? '✓' : String(i + 1) }),
            h('span', { text: t.name }),
            t.done ? null : h('span', { class: 'muted', text: `${percent(t.progress, false)}%` }),
          ),
        ),
      ),
      now ? h('p', { class: 'muted small', text: `${now.name}: ${now.rule.charAt(0).toLowerCase()}${now.rule.slice(1)}.` }) : null,
    ),
  );
}

function render(): HTMLElement[] {
  const s = getSave();
  const st = collectorStats(s);
  const ach = achievements(s);
  const mastery = allMastery(s.dex);
  const out: HTMLElement[] = [
    h(
      'div',
      { class: 'toolbar' },
      h('span', { class: 'muted', text: `Discovered ${st.discovered}/${st.total} species` }),
      h('div', { class: 'spacer' }),
      h('span', { class: 'badge', text: st.title }),
    ),
    h('p', { class: 'muted small', text: 'A species stays discovered even after you sell every specimen.' }),
    masteryOverview(mastery),
  ];
  for (const loc of LOCATIONS) {
    const open = isUnlocked(s, loc);
    const p = locationProgress(s, loc);
    const a = ach.find((x) => x.id === `loc:${loc.id}`);
    const sp = loc.special ? special(loc.special) : undefined;
    out.push(
      h(
        'section',
        { class: `dex-sec${open ? '' : ' locked'}`, attrs: { id: sectionId(loc.id) } },
        h(
          'div',
          { class: 'dex-head' },
          h('h3', null, open ? null : icon('lock', 'Locked'), ` ${loc.name}`),
          h('span', { class: 'muted small', text: `${p.have}/${p.of}` }),
          h('div', { class: 'spacer' }),
          a && a.done && !a.claimed ? claimButton(a.id, a.reward) : h('span', { class: 'muted small', text: a?.claimed ? 'collection reward claimed' : `complete for ${pearl(a?.reward ?? 0)} PEARL` }),
        ),
        open ? null : h('p', { class: 'warn small', text: unlockText(loc.unlock, s) }),
        masteryBlock(mastery[loc.id]),
        h('div', { class: 'grid dex-grid' }, loc.pool.map(([id]) => speciesCard(s, id, false, mastery[loc.id])), sp ? speciesCard(s, sp.speciesId, true, mastery[loc.id]) : null),
      ),
    );
  }
  return out;
}
