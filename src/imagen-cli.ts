/**
 * CLI tool for Nano Banana 2 image generation and editing.
 * Claude calls this via Bash when the user asks to generate or edit images.
 *
 * Usage:
 *   node dist/imagen-cli.js generate "a cat on Mars"
 *   node dist/imagen-cli.js edit /path/to/image.jpg "make the background blue"
 */

import { generateImage, editImage } from './imagen.js'
import { ensureUploadsDir } from './media.js'
import { initDatabase } from './db.js'

async function main(): Promise<void> {
  ensureUploadsDir()
  initDatabase()

  const [, , command, ...args] = process.argv

  switch (command) {
    case 'generate': {
      const prompt = args.join(' ')
      if (!prompt) {
        console.error('Usage: imagen-cli generate "<prompt>"')
        process.exit(1)
      }
      const result = await generateImage(prompt)
      if (result.imagePath) {
        console.log(`IMAGE_PATH=${result.imagePath}`)
      }
      if (result.text) {
        console.log(`TEXT=${result.text}`)
      }
      if (!result.imagePath) {
        console.error('No image generated')
        process.exit(1)
      }
      break
    }

    case 'edit': {
      const imagePath = args[0]
      const prompt = args.slice(1).join(' ')
      if (!imagePath || !prompt) {
        console.error('Usage: imagen-cli edit <image_path> "<prompt>"')
        process.exit(1)
      }
      const result = await editImage(imagePath, prompt)
      if (result.imagePath) {
        console.log(`IMAGE_PATH=${result.imagePath}`)
      }
      if (result.text) {
        console.log(`TEXT=${result.text}`)
      }
      if (!result.imagePath) {
        console.error('No image generated')
        process.exit(1)
      }
      break
    }

    default:
      console.error('Usage:')
      console.error('  imagen-cli generate "<prompt>"')
      console.error('  imagen-cli edit <image_path> "<prompt>"')
      process.exit(1)
  }
}

main().catch(err => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
