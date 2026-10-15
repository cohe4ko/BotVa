import { describe, it, expect } from 'vitest'
import { LAYER } from 'telegram/tl/AllTLObjects.js'
import { Api } from 'telegram/tl/api.js'

/**
 * `scripts/patch-gramjs.mjs` піднімає GramJS з шару 198 до 222 через
 * postinstall. Патч живе в node_modules, тобто зникає від будь-якого
 * `npm ci` без postinstall — а зникає тихо: код зібрався б, а нотатка до
 * контакту просто не долетіла б до Telegram. Хай про це говорить тест.
 */
describe('MTProto-шар встановленої GramJS', () => {
  it('не нижчий за 222 — інакше патч не застосувався', () => {
    expect(LAYER).toBeGreaterThanOrEqual(222)
  })

  it('несе поле note у contacts.addContact', () => {
    // Шар домовляється в initConnection, тож сервер серіалізує відповіді під
    // нього. Той самий id — ознака, що ми говоримо з ним тією ж мовою.
    expect(Api.contacts.AddContact.CONSTRUCTOR_ID).toBe(0xd9ba2e54)
  })

  it('лишає на місці класи, якими користується сам GramJS', () => {
    // На шарі 229 keyboardButton* злилися в один union-конструктор і ці класи
    // зникають — код бібліотеки почав би падати на розборі клавіатур.
    expect(Api.KeyboardButtonCallback).toBeDefined()
    expect(Api.KeyboardButtonUrl).toBeDefined()
    expect(Api.KeyboardButtonSwitchInline).toBeDefined()
  })
})
