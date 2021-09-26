require('./main.css');
import AliOssStreamUploader from '@vision_intelligence/oss_uploader';
import * as $ from "jquery";

const name = "test_2021-09-16_1";
const uploaderOptions = {
  minPartSize: 204800,
}


let mediaRecorder:any;
const blob_time_range = 1000;
const token = "69792056-1c4c-11ec-b366-00163e1802d1";
const tokenUrl = "https://api.tf.visionwx.com/media/v1/ossAccessCredentials";

let ALI_OSS_UPLOADER = new AliOssStreamUploader(name, getOssStsToken, uploaderOptions);
ALI_OSS_UPLOADER.onStartUpload = () => {
  console.log("onStartUpload");
  // 初始化成功，开始录屏
  // startScreenRecording();
};
ALI_OSS_UPLOADER.onStartUploadFailed = (err) => {
  console.log("onStartUploadFailed", err);
};
ALI_OSS_UPLOADER.onCompleteUpload = () => {
  console.log("onCompleteUpload");
};
ALI_OSS_UPLOADER.onCompleteUploadFailed = (err) => {
  console.log("onCompleteUploadFailed", err);
};
ALI_OSS_UPLOADER.onUploadPart = (res) => {
  console.log("onUploadPart", res);
};
ALI_OSS_UPLOADER.onUploadPartFailed = (err) => {
  console.log("onUploadPartFailed", err);
};

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

// function t() {
//   let imageCapture;
//   navigator.mediaDevices.getDisplayMedia(constraints).then(function(stream) {
//     imageCapture = new ImageCapture(stream.getVideoTracks()[0]);
//     imageCapture.grabFrame().then((img) => {
//       console.log(img);
//     });
//     imageCapture.takePhoto().then((img) => {
//       console.log(img);
//     });
//   });
// }

// function processRecordData(blobData) {
  
//   let videoSliceObj = document.getElementById("video_slice");
//   videoSliceObj.src = URL.createObjectURL(blobData);
//   videoSliceObj.play();

//   console.log("start opencv");
//   let cap = new window.cv.VideoCapture(videoSliceObj);
//   console.log(cap);
//   let src = new window.cv.Mat(blobData.size, cv.CV_8UC4);
//   cap.read(src);
//   console.log(src);

// }

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
}

initBtn();