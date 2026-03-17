/**
 * Auto-react to user messages using embedding similarity.
 * Zero tokens — runs entirely on local embedding service.
 *
 * Approach: every Telegram reaction emoji is embedded with a semantic
 * description. User message is compared against ALL emoji embeddings.
 * The system discovers the best match — no hardcoded categories.
 */

import { embed, embedBatch, cosineSim } from './embeddings.js'
import { logger } from './logger.js'

// Every available Telegram reaction emoji with semantic description.
// Description is what gets embedded — richer description = better matching.
const EMOJI_DESCRIPTORS: { emoji: string; desc: string }[] = [
  // Positive / approval
  { emoji: '👍', desc: 'good, ok, agree, approve, yes, confirmed, все добре, згоден, так, підтверджую' },
  { emoji: '👎', desc: 'bad, disagree, no, dislike, thumbs down, не згоден, ні, погано' },
  { emoji: '❤️', desc: 'love, thank you, grateful, appreciation, дякую, спасибі, люблю, вдячний, мерсі' },
  { emoji: '🔥', desc: 'amazing, fire, hot, excellent, cool, круто, клас, вогонь, шикарно, бомба' },
  { emoji: '🥰', desc: 'adore, sweet, cute, warm feelings, милота, обожнюю, ніжність, мило' },
  { emoji: '👏', desc: 'applause, bravo, well done, congratulations, браво, молодець, аплодисменти' },
  { emoji: '😁', desc: 'happy, grinning, cheerful, glad, радий, веселий, посмішка' },
  { emoji: '🤔', desc: 'thinking, hmm, curious, wondering, not sure, хм, думаю, цікаво, не впевнений' },
  { emoji: '🤯', desc: 'mind blown, shocked, unbelievable, amazing discovery, шок, нічого собі, вибух мозку' },
  { emoji: '😱', desc: 'scared, terrified, omg, horror, oh no, жах, страшно, ой' },
  { emoji: '🤬', desc: 'angry, furious, cursing, rage, злий, лютий, лайка' },
  { emoji: '😢', desc: 'sad, crying, upset, unfortunate, disappointing, сумно, плачу, шкода, прикро' },
  { emoji: '🎉', desc: 'celebration, party, congrats, hooray, success, свято, вітаю, ура, перемога, вдалось' },
  { emoji: '🤩', desc: 'star struck, wow, fantastic, impressed, захоплений, вау, фантастика' },
  { emoji: '🤮', desc: 'disgusting, gross, vomit, ew, огидно, фу, бридко' },
  { emoji: '💩', desc: 'crap, terrible, awful, shit quality, лайно, жахливо, відстій' },
  { emoji: '🙏', desc: 'please, pray, hope, grateful, thank you, будь ласка, прошу, дякую, надіюсь' },
  { emoji: '👌', desc: 'perfect, ok, fine, understood, got it, чудово, ок, зрозуміло, ясно' },
  { emoji: '🕊', desc: 'peace, calm, harmony, dove, мир, спокій, гармонія' },
  { emoji: '🤡', desc: 'clown, joke, ridiculous, foolish, silly, клоун, жарт, дурня, смішний' },
  { emoji: '🥱', desc: 'boring, yawn, sleepy, tedious, нудно, позіхаю, сонний' },
  { emoji: '🥴', desc: 'drunk, dizzy, confused, woozy, п\'яний, заплутаний' },
  { emoji: '😍', desc: 'love eyes, beautiful, gorgeous, stunning, красиво, прекрасно, чудово' },
  { emoji: '🐳', desc: 'whale, big, ocean, marine, кит, великий, море' },
  { emoji: '❤️‍🔥', desc: 'burning love, passion, intense, desire, пристрасть, палке кохання' },
  { emoji: '🌚', desc: 'creepy, suspicious, dark humor, subtle, хитрий, підозрілий, темний гумор' },
  { emoji: '🌭', desc: 'hot dog, random, food, funny, хот-дог, рандомний' },
  { emoji: '💯', desc: 'hundred percent, absolutely, totally agree, exactly right, стовідсотково, абсолютно, саме так' },
  { emoji: '🤣', desc: 'laughing hard, rofl, hilarious, dying of laughter, ахаха, ржу, помираю зі сміху' },
  { emoji: '⚡️', desc: 'fast, lightning, energy, power, quick, швидко, блискавка, енергія, потужно' },
  { emoji: '🍌', desc: 'banana, silly, random, funny, банан' },
  { emoji: '🏆', desc: 'trophy, winner, champion, achievement, victory, трофей, переможець, досягнення, чемпіон' },
  { emoji: '💔', desc: 'heartbreak, sad, disappointed, painful, розбите серце, розчарування, біль' },
  { emoji: '🤨', desc: 'suspicious, skeptical, raised eyebrow, doubt, підозрілий, скептичний, сумніваюсь' },
  { emoji: '😐', desc: 'neutral, meh, indifferent, unimpressed, байдуже, ніяк, без емоцій' },
  { emoji: '🍓', desc: 'strawberry, sweet, berry, cute, полуниця, солодкий' },
  { emoji: '🍾', desc: 'champagne, celebrate, toast, party, шампанське, святкуємо, тост' },
  { emoji: '💋', desc: 'kiss, love, romantic, affection, поцілунок, кохання' },
  { emoji: '🖕', desc: 'middle finger, screw you, rude, fuck off, нахабний' },
  { emoji: '😈', desc: 'devil, mischief, evil, naughty, temptation, диявол, пустощі, хитрий' },
  { emoji: '😴', desc: 'sleeping, tired, bored, zzz, сплю, втомився, нудно' },
  { emoji: '😭', desc: 'sobbing, crying hard, overwhelmed, emotional, ридаю, зворушений, сильно плачу' },
  { emoji: '🤓', desc: 'nerd, smart, geek, glasses, intellectual, нерд, розумний, гік' },
  { emoji: '👻', desc: 'ghost, spooky, boo, halloween, scary, привид, бу, страшно' },
  { emoji: '👨‍💻', desc: 'programmer, developer, coding, working, hacker, програміст, кодер, працюю' },
  { emoji: '👀', desc: 'looking, watching, eyes, attention, noticed, interesting, дивлюсь, помітив, цікаво' },
  { emoji: '🎃', desc: 'halloween, pumpkin, spooky, scary, autumn, гарбуз, хелловін' },
  { emoji: '🙈', desc: 'embarrassed, oops, hide, shy, oh no, ой, соромно, ховаюсь' },
  { emoji: '😇', desc: 'angel, innocent, pure, good, holy, ангел, невинний, святий' },
  { emoji: '😨', desc: 'fearful, anxious, worried, nervous, scared, боюсь, тривожно, хвилююсь' },
  { emoji: '🤝', desc: 'handshake, deal, agreement, partnership, hello, домовились, угода, привіт' },
  { emoji: '✍️', desc: 'writing, note, working on it, creating, пишу, нотатка, працюю над' },
  { emoji: '🤗', desc: 'hug, warm, welcome, supportive, friendly, обійми, тепло, підтримка' },
  { emoji: '🫡', desc: 'salute, yes sir, on it, roger, will do, так точно, є, зрозумів, зроблю, слухаюсь' },
  { emoji: '🎅', desc: 'santa, christmas, gift, holiday, winter, санта, різдво, подарунок' },
  { emoji: '🎄', desc: 'christmas tree, holiday, festive, december, ялинка, свято' },
  { emoji: '☃️', desc: 'snowman, winter, cold, snow, сніговик, зима, холодно' },
  { emoji: '💅', desc: 'sassy, fabulous, confident, unbothered, queen, впевнена, фабулос' },
  { emoji: '🤪', desc: 'crazy, wild, zany, silly, wacky, божевільний, шалений, дурний' },
  { emoji: '🗿', desc: 'stone face, bruh, deadpan, moyai, unfazed, кам\'яне обличчя, серйозний' },
  { emoji: '🆒', desc: 'cool, alright, chill, no worries, кул, норм, без проблем' },
  { emoji: '💘', desc: 'cupid, falling in love, romance, crush, закоханість, романтика' },
  { emoji: '🙉', desc: 'not listening, ignore, la la la, не чую, ігнорую' },
  { emoji: '🦄', desc: 'unicorn, magical, rare, special, unique, єдиноріг, магічний, унікальний' },
  { emoji: '😘', desc: 'blowing kiss, love, flirty, bye, air kiss, повітряний поцілунок, бувай' },
  { emoji: '💊', desc: 'pill, medicine, health, cure, drug, таблетка, ліки, здоров\'я' },
  { emoji: '🙊', desc: 'oops said too much, secret, covering mouth, ой сказав зайве, секрет' },
  { emoji: '😎', desc: 'cool, sunglasses, confident, badass, smooth, крутий, впевнений, стильний' },
  { emoji: '👾', desc: 'alien, game, pixel, space invader, retro, інопланетянин, гра, ретро' },
  { emoji: '🤷‍♂️', desc: 'shrug, don\'t know, whatever, no idea, не знаю, без поняття, ну хз' },
  { emoji: '🤷', desc: 'shrug, don\'t know, whatever, no idea, не знаю, без поняття' },
  { emoji: '🤷‍♀️', desc: 'shrug, don\'t know, whatever, no idea, не знаю, без поняття' },
  { emoji: '😡', desc: 'angry, mad, furious, rage, pissed, злий, розлючений, бісить' },
]

const SIMILARITY_THRESHOLD = 0.55 // lower threshold since we match individual emoji, not clusters
const MAX_MESSAGE_LENGTH = 200

// Pre-computed emoji embeddings (cached after first use)
let emojiEmbeddings: { emoji: string; vec: Float32Array }[] | null = null
let initPromise: Promise<void> | null = null

/**
 * Initialize emoji embeddings. Called once, cached forever.
 * Uses batch embedding for efficiency (~70 descriptions in one call).
 */
async function initRefs(): Promise<void> {
  if (emojiEmbeddings) return
  if (initPromise) { await initPromise; return }

  initPromise = (async () => {
    const descriptions = EMOJI_DESCRIPTORS.map(d => d.desc)
    const vectors = await embedBatch(descriptions, 'passage')

    const results: { emoji: string; vec: Float32Array }[] = []
    for (let i = 0; i < EMOJI_DESCRIPTORS.length; i++) {
      const vec = vectors[i]
      if (vec) {
        results.push({ emoji: EMOJI_DESCRIPTORS[i].emoji, vec })
      }
    }

    emojiEmbeddings = results
    logger.info({ emojis: results.length }, 'Auto-react: all emoji embeddings initialized')
  })()

  await initPromise
}

/**
 * Classify a message and return the best matching emoji, or null.
 * Compares against ALL Telegram reaction emoji — no fixed categories.
 */
export async function classifyReaction(message: string): Promise<string | null> {
  if (message.length < 1 || message.length > MAX_MESSAGE_LENGTH) return null
  if (message.startsWith('/')) return null

  await initRefs()
  if (!emojiEmbeddings || emojiEmbeddings.length === 0) return null

  const msgVec = await embed(message, 'query')
  if (!msgVec) return null

  // Find top matches
  const scored: { emoji: string; score: number }[] = []
  for (const ref of emojiEmbeddings) {
    const score = cosineSim(msgVec, ref.vec)
    if (score >= SIMILARITY_THRESHOLD) {
      scored.push({ emoji: ref.emoji, score })
    }
  }

  if (scored.length === 0) return null

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score)

  // Pick from top 3 with weighted random for variety
  // Higher score = higher chance, but not deterministic
  const top = scored.slice(0, 3)
  const emoji = weightedPick(top)

  logger.debug({
    emoji,
    top: top.map(t => `${t.emoji}:${t.score.toFixed(3)}`).join(' '),
    message: message.slice(0, 50),
  }, 'Auto-react match')

  return emoji
}

/**
 * Weighted random pick from scored candidates.
 * Score difference matters: 0.8 vs 0.6 gives strong preference to 0.8.
 */
function weightedPick(candidates: { emoji: string; score: number }[]): string {
  if (candidates.length === 1) return candidates[0].emoji

  // Use score as weight (squared for stronger preference to top match)
  const weights = candidates.map(c => c.score * c.score)
  const total = weights.reduce((s, w) => s + w, 0)
  let roll = Math.random() * total

  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return candidates[i].emoji
  }

  return candidates[0].emoji
}
