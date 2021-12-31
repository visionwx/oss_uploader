require('./main.css');
// import AliOssStreamUploader, {Options, StsToken, UploadJob} from '@vision_intelligence/oss_uploader';
import * as $ from "jquery";
import AliOssStreamUploader, {Options, StsToken, UploadJob} from '../../lib/index';

const name = "test_2021-12-31_1";
const uploaderOptions = {
  minPartSize: 204800,
  debug: true
}

let mediaRecorder:any;
let media_record_buffer:any = {};
const blob_time_range = 1000;
const token = "***********";
const tokenUrl = "https://********/media/v1/ossAccessCredentials";

let ALI_OSS_UPLOADER = new AliOssStreamUploader(name, getOssStsToken, uploaderOptions);
ALI_OSS_UPLOADER.onStartUpload = () => {
  console.log("onStartUpload");
  // 初始化成功，开始录屏
  // startScreenRecording();
};
ALI_OSS_UPLOADER.onCompleteUpload = () => {
  let ckpt = ALI_OSS_UPLOADER.generateCheckpoint({
    event: 'onCompleteUpload'
  });
  console.log("onCompleteUpload", ckpt);
  uploadBuffer(name + "_onCompleteUpload.json", ckpt);
};
ALI_OSS_UPLOADER.onCompleteUploadFailed = (err) => {
  let ckpt = ALI_OSS_UPLOADER.generateCheckpoint({
    event: 'onCompleteUploadFailed'
  });
  console.log("onCompleteUploadFailed", err);
  initOssResumeUploader(ckpt);
  uploadBuffer(name + "_onCompleteUploadFailed.json", ckpt);
};
ALI_OSS_UPLOADER.onUploadPart = (res) => {
  console.log("onUploadPart", res);
};
ALI_OSS_UPLOADER.onUploadPartFailed = (partIndex, partData) => {
  console.log("onUploadPartFailed", partIndex);
  // media_record_buffer[ALI_OSS_UPLOADER.uploadId + "_" + partIndex] = partData;
};
ALI_OSS_UPLOADER.onReadyFailed = (err) => {
  console.log("onReadyFailed", err);
  window.alert("uploader init failed, please check the network");
  stopRecording();
}


function initOssResumeUploader(checkpoint:any) {
  console.log(checkpoint);
  let oss_resume_uploader = new AliOssStreamUploader(
      "resume",
      getOssStsToken,
      {
          minPartSize: 204800
      }
  );
  oss_resume_uploader.onCompleteUpload = () => {
      window.alert("resume upload success");
      let ckpt = oss_resume_uploader.generateCheckpoint({
        event: 'onResumeCompleteUpload'
      });
      uploadBuffer(name + "_onResumeCompleteUpload.json", ckpt);
  }
  oss_resume_uploader.onCompleteUploadFailed = (err) => {
      console.error("onCompleteUploadFailed", err);
      console.log(oss_resume_uploader.generateCheckpoint());
      setTimeout(() => {
          initOssResumeUploader(checkpoint);
      }, 5000);
  }
  oss_resume_uploader.onReadyFailed = (err) => {
      console.error("onReadyFailed", err);
      setTimeout(() => {
          initOssResumeUploader(checkpoint);
      }, 5000);
  }
  oss_resume_uploader.onUploadPart = (partIndex) => {
      console.log("oss_resume_uploader.onUploadPart,", oss_resume_uploader.uploadId + "_" + partIndex);
      media_record_buffer[oss_resume_uploader.uploadId + "_" + partIndex] = null;
      delete media_record_buffer[oss_resume_uploader.uploadId + "_" + partIndex];
  }
  oss_resume_uploader.onReady = () => {
      oss_resume_uploader.resumeCheckpoint(checkpoint, (uploadId, partIndex) => {
          return new Promise(function(resolve, reject) {
              let partData = media_record_buffer[uploadId + "_" + partIndex];
              if (partData != null) {
                  resolve(partData);
              } else {
                  reject();
              }
          });
      });
  }
}

function newRecording(stream: any) {
  // Start Media Recorder
  let mediaConstraints = {
    mimeType: 'video/webm;codecs=vp8,opus',
    // bitsPerSecond: 1000
  }
  mediaRecorder = new MediaRecorder(stream, mediaConstraints);
}

function showRecording(stream: any) {
  let video:any = document.getElementById("video");
  if (video != null) {
    video.srcObject = stream;
    video.onloadedmetadata = function(e:any) {
        video.play();
    };
  }
}

function endRecording(stream:any) {
  // Stop tab and microphone streams
  stream.getTracks().forEach(function(track:any) {
    track.stop();
  });

  // 结束上传
  ALI_OSS_UPLOADER.end();
  
}

// function saveRecording(recordedBlobs:Blob[]) {
//   let newwindow = window.open('../html/videoeditor.html');
//   newwindow.recordedBlobs = recordedBlobs;
// }

function pauseRecording() {
  mediaRecorder.pause();
}

function resumeRecording() {
  mediaRecorder.resume();
}

function startScreenRecording() {
  let constraints = {
    audio: true,
    video: true
  };
  navigator.mediaDevices.getDisplayMedia(constraints).then(function(stream) {
    // Set up media recorder & inject content
    newRecording(stream);

    showRecording(stream);
  
    // Record desktop stream
    mediaRecorder.ondataavailable = (event:any) => {
      if (event.data && event.data.size > 0) {
        ALI_OSS_UPLOADER.push(event.data);
      }
    };
  
    // When the recording is stopped
    mediaRecorder.onstop = () => {
      endRecording(stream);
    }
  
    // Stop recording if stream is ended via Chrome UI or another method
    stream.getVideoTracks()[0].onended = function() {
      mediaRecorder.stop();
    }

    mediaRecorder.start(blob_time_range);

  })
}

function startRecording() {
  // ALI_OSS_UPLOADER.start();
  startScreenRecording();
}

function stopRecording() {
  mediaRecorder.stop();
}

function getOssStsToken() {
    return new Promise(function(resolve, reject) {
        console.log(token);
        if (token === null) {
            // 用户未登录情况处理
            console.error("user token not found");
            reject("tokenNotFound");
        } else {
            // 用户已经登录情况处理，根据token获取用户信息
            $.ajax({
                url: tokenUrl,
                type: 'GET',
                headers: {
                    authorization: token,
                },
                cache: false,
                async: true,
                dataType: 'json',
                success: function(data) {
                    console.log("get oss token success", data);
                    if (data.status == 1) {
                        let creds = data.data.credentials;
                        resolve(creds);
                    } else {
                        reject(data.message);
                    }
                    
                },
                error: function(xhr) {
                    console.log(xhr);
                    reject(xhr);
                }
            });
        }
    });
}

function uploadBuffer(uploadPath:string, datas:object) {
  ALI_OSS_UPLOADER.uploadBuffer(
    uploadPath, 
    new Blob([JSON.stringify(datas)])
  ).then((res) => {
    console.log("upload buffer success", res);
  }).catch((err) => {
    console.error("upload buffer failed", err);
  });
}

function initBtn() {
    if (document === null) return; 

    const recordBtn = document.getElementById("btn");
    if (recordBtn != null) {
        recordBtn.onclick = () => {
            console.log("start record");
            startRecording();
        }
    } 

    const stopRecordBtn = document.getElementById("btn2");
    if (stopRecordBtn != null) {
        stopRecordBtn.onclick = () => {
            console.log("stop record");
            stopRecording();
        }
    }

    const uploadBufferBtn = document.getElementById("btn3");
    if (uploadBufferBtn != null) {
      uploadBufferBtn.onclick = () => {
            console.log("start upload buffer");
            let datas = {
              "name": "test",
              "cpu": [
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50},
                {"usage": 50}
              ],
            };
            uploadBuffer(
              "upload_buffer/logs/2021-12-31.json",
              datas
            );
        }
    }
}

initBtn();