/**
 * Which release of the game a chain runs, and how to read each.
 *
 * Release 004 added one field to a cast (`counted`) and one to the lens's view of a player (`castingPaused`), and
 * with it the long reel window (8,191 blocks through the chain's block-hash history instead of 256). Release 005
 * added another field to a cast (`fight`: the fish on it has to be reeled in, contracts/src/ReelJudge.sol) and
 * gave `reel` an argument, the recording of the fight. A page or a keeper built from this source may meet any of
 * them: the release before an upgrade, the next one after it. Reading a release with another's shape does not
 * always fail, it can also decode into nonsense, so the release is asked first and the matching shape is used.
 *
 * Pure: the caller makes the calls and passes the answers in.
 */
import { decodeFunctionResult, type Abi, type ContractFunctionReturnType, type Hex } from 'viem';
import { gameLensAbi } from '../abi';

/** `castOf(address)`: its answer is as long as a cast is, on every release. */
export const CAST_OF_SELECTOR = '0xc3022da6' as const;

/** 3: release 003 and earlier. 4: release 004. 5: release 005 and later. */
export type GameRelease = 3 | 4 | 5;

/** Words in a cast: six up to release 003, seven in 004, eight from 005 on. */
const WORDS: Record<number, GameRelease> = { 6: 3, 7: 4, 8: 5 };

const wordsOf = (answer: Hex | undefined): number => (answer ? (answer.length - 2) / 64 : 0);

/** The release of the game that answered `castOf` with `data`. Throws on an answer that is no cast at all. */
export function releaseOf(castOfAnswer: Hex | undefined): GameRelease {
  const words = wordsOf(castOfAnswer);
  if (words < 6 || !Number.isInteger(words)) throw new Error('castOf answered with something that is not a cast');
  return WORDS[words] ?? 5;
}

/** Whether the game that answered `castOf` with `data` is release 004 or later. Throws on an answer that is no cast at all. */
export const isRelease004 = (castOfAnswer: Hex | undefined): boolean => releaseOf(castOfAnswer) >= 4;

/**
 * Whether the cast in a `castOf` answer has to be reeled in with a fight: the eighth word, which only a game that
 * checks fights writes. Asked of the game itself and not of a lens: the lens of an earlier release leaves the
 * word out, and a page that then settled the cast the old way would lose the fish.
 */
export function castNeedsFight(castOfAnswer: Hex | undefined): boolean {
  if (releaseOf(castOfAnswer) < 5) return false;
  return BigInt(`0x${castOfAnswer!.slice(2 + 64 * 7, 2 + 64 * 8)}`) !== 0n;
}

/** How long after its randomness block a cast can be landed: the long window needs the release and the chain's history both. */
export function reelWindowOf(release004: boolean, historyAnswers: boolean): bigint {
  return release004 && historyAnswers ? 8191n : 256n;
}

export type PlayerView = ContractFunctionReturnType<typeof gameLensAbi, 'view', 'playerView'>;

const current = gameLensAbi.find((x) => x.type === 'function' && x.name === 'playerView')!;

/** `playerView` as an earlier lens answers it: the current one without the fields later releases added. */
function shapeWithout(view: string[], cast: string[]): Abi {
  return [
    {
      ...current,
      outputs: [
        {
          ...current.outputs[0],
          components: current.outputs[0].components
            .filter((c) => !view.includes(c.name))
            .map((c) => (c.name === 'cast' && 'components' in c ? { ...c, components: c.components.filter((x) => !cast.includes(x.name)) } : c)),
        },
      ],
    },
  ] as unknown as Abi;
}
const released003 = shapeWithout(['castingPaused'], ['counted', 'fight']);
const released004 = shapeWithout([], ['fight']);

/**
 * A lens's answer to `playerView`, in the current shape whichever release's lens gave it. `lens` is the release
 * the lens was built for; a lens never changes, so that is a fact about its address.
 */
export function decodePlayerView(data: Hex, lens: GameRelease): PlayerView {
  if (lens === 5) return decodeFunctionResult({ abi: gameLensAbi, functionName: 'playerView', data });
  if (lens === 4) {
    const v = decodeFunctionResult({ abi: released004, functionName: 'playerView', data }) as Omit<PlayerView, 'cast'> & { cast: Omit<PlayerView['cast'], 'fight'> };
    // release 004 knows no fights: any bite is a catch
    return { ...v, cast: { ...v.cast, fight: false } };
  }
  const v = decodeFunctionResult({ abi: released003, functionName: 'playerView', data }) as Omit<PlayerView, 'castingPaused' | 'cast'> & { cast: Omit<PlayerView['cast'], 'counted' | 'fight'> };
  // release 003 neither counts casts nor can pause them
  return { ...v, cast: { ...v.cast, counted: false, fight: false }, castingPaused: false };
}
