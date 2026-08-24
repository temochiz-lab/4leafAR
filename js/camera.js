export class CameraController {
  constructor(video) {
    this.video = video;
    this.stream = null;
  }

  async start() {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("このブラウザではカメラAPIを利用できません。");
    }

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    await this.video.play();
    return this.video;
  }

  stop() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
