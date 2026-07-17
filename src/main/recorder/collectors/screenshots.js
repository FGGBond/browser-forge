export class ScreenshotsCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._screenshots = []
  }
  addScreenshot({ timestamp, dataBase64 }) { this._screenshots.push({ timestamp, dataBase64 }) }
  getScreenshots() { return this._screenshots }
}
