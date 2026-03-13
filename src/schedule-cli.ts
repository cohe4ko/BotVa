import { randomUUID } from 'crypto'
import cronParser from 'cron-parser'
import { initDatabase, createTask, listTasks, deleteTask, pauseTask, resumeTask, getTask } from './db.js'

function printUsage(): void {
  console.log(`
Usage:
  schedule-cli create "<prompt>" "<cron>" <chat_id>
  schedule-cli list
  schedule-cli delete <id>
  schedule-cli pause <id>
  schedule-cli resume <id>

Examples:
  schedule-cli create "Summarize my emails" "0 9 * * *" 123456789
  schedule-cli list
  schedule-cli delete abc-123
`)
}

function main(): void {
  initDatabase()

  const [, , command, ...args] = process.argv

  switch (command) {
    case 'create': {
      const [prompt, cron, chatId] = args
      if (!prompt || !cron || !chatId) {
        console.error('Usage: schedule-cli create "<prompt>" "<cron>" <chat_id>')
        process.exit(1)
      }

      // Validate cron
      try {
        cronParser.parseExpression(cron)
      } catch {
        console.error(`Invalid cron expression: ${cron}`)
        process.exit(1)
      }

      const id = randomUUID().slice(0, 8)
      const nextRun = Math.floor(cronParser.parseExpression(cron).next().getTime() / 1000)
      createTask(id, chatId, prompt, cron, nextRun)
      console.log(`Task created: ${id}`)
      console.log(`  Prompt: ${prompt}`)
      console.log(`  Schedule: ${cron}`)
      console.log(`  Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
      break
    }

    case 'list': {
      const tasks = listTasks()
      if (tasks.length === 0) {
        console.log('No scheduled tasks.')
        return
      }
      console.log('\nScheduled Tasks:')
      console.log('─'.repeat(80))
      for (const t of tasks) {
        console.log(`  ID: ${t.id}  Status: ${t.status}`)
        console.log(`  Prompt: ${t.prompt.slice(0, 60)}`)
        console.log(`  Schedule: ${t.schedule}`)
        console.log(`  Next run: ${new Date(t.next_run * 1000).toLocaleString()}`)
        if (t.last_run) {
          console.log(`  Last run: ${new Date(t.last_run * 1000).toLocaleString()}`)
        }
        console.log('─'.repeat(80))
      }
      break
    }

    case 'delete': {
      const id = args[0]
      if (!id) { console.error('Usage: schedule-cli delete <id>'); process.exit(1) }
      if (deleteTask(id)) console.log(`Task ${id} deleted.`)
      else console.error(`Task ${id} not found.`)
      break
    }

    case 'pause': {
      const id = args[0]
      if (!id) { console.error('Usage: schedule-cli pause <id>'); process.exit(1) }
      if (pauseTask(id)) console.log(`Task ${id} paused.`)
      else console.error(`Task ${id} not found.`)
      break
    }

    case 'resume': {
      const id = args[0]
      if (!id) { console.error('Usage: schedule-cli resume <id>'); process.exit(1) }
      if (resumeTask(id)) console.log(`Task ${id} resumed.`)
      else console.error(`Task ${id} not found.`)
      break
    }

    default:
      printUsage()
  }
}

main()
