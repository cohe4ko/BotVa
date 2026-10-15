#!/usr/bin/env node
/**
 * Підняти GramJS з MTProto-шару 198 до 222.
 *
 * GramJS не має згенерованих класів у коді — `tl/api.js` будує їх на старті
 * з TL-схеми, яка лежить рядком у `tl/apiTl.js`. Тобто підняти шар — це
 * замінити цей рядок і константу LAYER, а не переписувати бібліотеку.
 *
 * Схема у `vendor/telegram-api-222.tl` — з генератора Telethon: той самий
 * діалект, який парсер GramJS і читає. Апстрім GramJS стоїть (останній
 * реліз 2.26.22 — шар 198, master на GitHub взагалі 193), тож без цього
 * патча недоступні поля, доданих після 198: зокрема нотатка до контакту
 * (`contacts.addContact.note`, `userFull.note`, шар 214+).
 *
 * Чому саме 222, а не 229 з tdesktop: на 229 Telegram злив усі
 * keyboardButton* в один конструктор з union-типом ButtonType, і дев'ять
 * класів, на які спирається код самої GramJS, зникають. На 222 не зникає
 * жоден — перевірено звіркою всіх 670 посилань `Api.*` у бібліотеці.
 *
 * Патч самоскасовний: щойно апстрім випустить 222 або новіше, скрипт
 * побачить це по LAYER і нічого не робитиме. Тоді vendor-схему і цей
 * скрипт можна видалити.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const TARGET_LAYER = 222

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'node_modules', 'telegram', 'tl')
const SCHEMA = join(ROOT, 'vendor', `telegram-api-${TARGET_LAYER}.tl`)

const ALL_TL = join(LIB, 'AllTLObjects.js')
const API_TL = join(LIB, 'apiTl.js')
const API_DTS = join(LIB, 'api.d.ts')

function say(msg) { console.log(`[patch-gramjs] ${msg}`) }

if (!existsSync(ALL_TL)) {
  say('пакет telegram не встановлено — пропускаю')
  process.exit(0)
}

const allTl = readFileSync(ALL_TL, 'utf8')
const current = Number(allTl.match(/exports\.LAYER = (\d+);/)?.[1])

if (!Number.isFinite(current)) {
  console.error('[patch-gramjs] не знайшов exports.LAYER — структура пакета змінилась, патч не застосовано')
  process.exit(1)
}

if (current >= TARGET_LAYER) {
  say(`GramJS уже на шарі ${current} — патч не потрібен`)
  process.exit(0)
}

if (!existsSync(SCHEMA)) {
  console.error(`[patch-gramjs] немає ${SCHEMA}`)
  process.exit(1)
}

// Схема лягає всередину шаблонного рядка, тож усе, що його ламає, екранується.
const tl = readFileSync(SCHEMA, 'utf8')
const escaped = tl.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

writeFileSync(API_TL, `"use strict";\nmodule.exports = \`${escaped}\`;\n`)
writeFileSync(ALL_TL, allTl.replace(/exports\.LAYER = \d+;/, `exports.LAYER = ${TARGET_LAYER};`))

// Типи GramJS генерує власним тулінгом, якого немає в опублікованому пакеті.
// Дописуємо руками тільки те, чим користуємось, — решта схеми і без того
// працює в рантаймі, а не оголошене в .d.ts просто не видно з TypeScript.
//
// Форма згенерованого файлу: поля кожного класу перелічені двічі — у
// дженерику (аргументи конструктора) і в тілі класу (властивості екземпляра).
// Для запису досить першого, для читання потрібні обидва.
const dtsPatches = [
  {
    what: 'contacts.AddContact.note (запис)',
    anchor: '      phone: string;\n    }>, Api.TypeUpdates> {\n    CONSTRUCTOR_ID: 3908330448;',
    insert: '      phone: string;\n      note?: Api.TypeTextWithEntities;\n    }>, Api.TypeUpdates> {\n    CONSTRUCTOR_ID: 3908330448;',
  },
  {
    what: 'UserFull.note (аргументи)',
    anchor: '  export class UserFull extends VirtualClass<{\n    // flags: null;\n',
    insert: '  export class UserFull extends VirtualClass<{\n    // flags: null;\n    note?: Api.TypeTextWithEntities;\n',
  },
  {
    what: 'UserFull.note (властивість)',
    anchor: '\n  static fromReader(reader: Reader): UserFull;\n',
    insert: '\n  static fromReader(reader: Reader): UserFull;\n    note?: Api.TypeTextWithEntities;\n',
  },
  {
    what: 'contacts.UpdateContactNote',
    anchor: '    export class AddContact extends Request<Partial<{',
    insert: `    export class UpdateContactNote extends Request<Partial<{
      id: Api.TypeEntityLike;
      note: Api.TypeTextWithEntities;
    }>, Bool> {
    CONSTRUCTOR_ID: 329212923;
    SUBCLASS_OF_ID: 4122188204;
    classType: "request";
    className: "contacts.UpdateContactNote";
    static fromReader(reader: Reader): UpdateContactNote;
      id: Api.TypeEntityLike;
      note: Api.TypeTextWithEntities;
    }
    export class AddContact extends Request<Partial<{`,
  },
  {
    // Без цього рядка `client.invoke()` не прийме новий запит: його параметр
    // типізований об'єднанням усіх відомих запитів.
    what: 'contacts.UpdateContactNote в AnyRequest',
    anchor: '| contacts.AddContact ',
    insert: '| contacts.UpdateContactNote | contacts.AddContact ',
  },
]

let dts = readFileSync(API_DTS, 'utf8')
for (const p of dtsPatches) {
  if (dts.includes(p.insert)) continue
  if (!dts.includes(p.anchor)) {
    console.error(`[patch-gramjs] не знайшов місце для ${p.what} у api.d.ts — типи лишаються старими`)
    continue
  }
  dts = dts.replace(p.anchor, p.insert)
}
writeFileSync(API_DTS, dts)

// Схема без цього класу зробила б патч тихо непридатним для того, заради чого він є.
const { Api } = await import('telegram/tl/api.js')
if (Api.contacts.AddContact.CONSTRUCTOR_ID !== 0xd9ba2e54) {
  console.error('[patch-gramjs] схема застосувалась, але contacts.addContact має інший id — перевір vendor-файл')
  process.exit(1)
}

say(`шар ${current} → ${TARGET_LAYER}`)
