/**
 * Which release of the game a chain runs, and how to read each.
 *
 * Release 004 added one field to a cast (`counted`) and one to the lens's view of a player (`castingPaused`), and
 * with it the long reel window (8,191 blocks through the chain's block-hash history instead of 256). A page or a
 * keeper built from this source may meet either: the release before the upgrade, the next one after it. Reading
 * a release with the other's shape does not always fail, it can also decode into nonsense, so the release is
 * asked first and the matching shape is used.
 *
 * Pure: the caller makes the calls and passes the answers in.
 */
import { decodeFunctionResult, type Abi, type ContractFunctionReturnType, type Hex } from 'viem';
import { gameLensAbi } from '../abi';

/** `castOf(address)`: its answer is as long as a cast is, on every release. */
export const CAST_OF_SELECTOR = '0xc3022da6' as const;

/** Words in a cast from release 004 on; six before it. */
const CAST_WORDS_004 = 7;

/** Whether the game that answered `castOf` with `data` is release 004 or later. Throws on an answer that is no cast at all. */
export function isRelease004(castOfAnswer: Hex | undefined): boolean {
  const words = castOfAnswer ? (castOfAnswer.length - 2) / 64 : 0;
  if (words < CAST_WORDS_004 - 1 || !Number.isInteger(words)) throw new Error('castOf answered with something that is not a cast');
  return words >= CAST_WORDS_004;
}

/** How long after its randomness block a cast can be landed: the long window needs the release and the chain's history both. */
export function reelWindowOf(release004: boolean, historyAnswers: boolean): bigint {
  return release004 && historyAnswers ? 8191n : 256n;
}

export type PlayerView = ContractFunctionReturnType<typeof gameLensAbi, 'view', 'playerView'>;

const current = gameLensAbi.find((x) => x.type === 'function' && x.name === 'playerView')!;
/** `playerView` as release 003's lens answers it: the current one without the two fields 004 added. */
const released003 = [
  {
    ...current,
    outputs: [
      {
        ...current.outputs[0],
        components: current.outputs[0].components
          .filter((c) => c.name !== 'castingPaused')
          .map((c) => (c.name === 'cast' && 'components' in c ? { ...c, components: c.components.filter((x) => x.name !== 'counted') } : c)),
      },
    ],
  },
] as unknown as Abi;

/** A lens's answer to `playerView`, in the current shape whichever release gave it. */
export function decodePlayerView(data: Hex, release004: boolean): PlayerView {
  if (release004) return decodeFunctionResult({ abi: gameLensAbi, functionName: 'playerView', data });
  const v = decodeFunctionResult({ abi: released003, functionName: 'playerView', data }) as Omit<PlayerView, 'castingPaused' | 'cast'> & { cast: Omit<PlayerView['cast'], 'counted'> };
  // release 003 neither counts casts nor can pause them
  return { ...v, cast: { ...v.cast, counted: false }, castingPaused: false };
}
