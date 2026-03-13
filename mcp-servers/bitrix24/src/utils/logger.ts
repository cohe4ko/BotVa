export class Logger {
  static info(message: string, data?: any) {
    console.error(`[INFO] ${new Date().toISOString()}: ${message}`, data || '');
  }
  
  static error(message: string, error?: any) {
    console.error(`[ERROR] ${new Date().toISOString()}: ${message}`, error || '');
  }
  
  static warn(message: string, data?: any) {
    console.error(`[WARN] ${new Date().toISOString()}: ${message}`, data || '');
  }
  
  static debug(message: string, data?: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error(`[DEBUG] ${new Date().toISOString()}: ${message}`, data || '');
    }
  }
}
