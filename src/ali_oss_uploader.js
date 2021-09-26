// const OSS = require('ali-oss');


// let ossRecording = new AliOssStreamUploader();
// ossRecording.onCompleteUpload = () => {}
// ossRecording.onUploadPartFailed = () => {
//   "1. save partData to local disk"
//   "2. save/update checkpoint"
// }
// ossRecording.onCompleteUploadFailed = () => {
//   checkpoint = ossRecording.generateCheckpoint();
//   "2. save/update checkpoint"
// }


// let ossCheckpoint = new AliOssStreamUploader();
// ossCheckpoint.resumeCheckpoint(checkpoint, (partIndex) => {
//   return new Promise();
// });
// ossCheckpoint.onCompleteUpload = () => {}
// ossCheckpoint.onCompleteUploadFailed = () => {}


const bucket = 'boom-video-test';
const region = 'oss-cn-shenzhen';
const ossMinPartSize = 102400;

// 0 init, 1 done, 2 failed
const UploadStatus = {
  uploading: 0,
  done: 1,
  failed: 2
}

function AliOssStreamUploader(name, creds, options) {
  this.init(name, creds, options);
}

// name = videos/<uploadJobId>_<userId>/<uploadJobId>.mp4

// creds = {
//    SecurityToken,
//    AccessKeyId,
//    AccessKeySecret,
//    Bucket,
//    Region,
// }

// options = {
//   minPartSize: number | 204800;
//   timeout?: number | undefined;
//   mime?: string | undefined;
//   meta?: UserMeta | undefined;
//   headers?: object | undefined;
// }

AliOssStreamUploader.prototype = {

  init: function(name, getToken, options) {
    this.store = null;
    this.name = name;
    this.creds = null;
    this.options = options;
    this.uploadId = null;
    this.uploadParts = [];
    this.uploadJobs  = []; // partIndex, partSize, status, retry, backup
    this.recordedBlobs = [];
    this.currentPartIndex = 0;
    this.currentPartSize = 0;
    this.dataIndex = 0;
    this.duration = null;

    // 回调函数
    this.onStartUpload = null; // 开始上传初始化成功
    this.onStartUploadFailed = null; // 开始上传初始化失败

    this.onCompleteUpload = null;       // 完成上传
    this.onCompleteUploadFailed = null; // 完成上传失败

    this.onUploadPart = null;           // 上传某个分片成功
    this.onUploadPartFailed = null;     // 上传某个分片失败

    this.onReady = null; // oss 对象已经准备好，相当于已经获取到sts token，并且初始化oss对象成功
    this.hasReady = false;
    this.onGetTokenFailed = null; // 获取sts token失败 callback

    // 获取分片数据函数
    this.getPartData = null;

    // 最小分片大小
    this.minPartSize = this.options.minPartSize || 204800;

    // 是否已经初始化成功
    this.isStarting = false;
    this.isUploadProcessRunning = false;
    this.isEnded = false;      // 是否主动发起结束
    this.isCompleted = false;  // 是否已经完成
    this.isCompleting = false; // 是否正在完成

    this.getToken = getToken;
    this.updateToken();
    
  },

  // generate checkpoint
  generateCheckpoint: function() {
    return {
      name: this.name,
      uploadId: this.uploadId,
      uploadParts: this.uploadParts,
      uploadJobs: this.uploadJobs,
      duration: this.duration,
      isEnded: this.isEnded,
    };
  },

  resumeCheckpoint: function(checkpoint, getPartData) {
    // check data
    if (!checkpoint.name || !checkpoint.uploadId || !checkpoint.uploadParts || !checkpoint.uploadJobs) {
      if (this.onCompleteUploadFailed != null) {
        this.onCompleteUploadFailed("checkpoint data missing");
      }
      return;
    }
    if (getPartData == null) {
      if (this.onCompleteUploadFailed != null) {
        this.onCompleteUploadFailed("getPartData func not provide");
      }
      return;
    }
    // load data
    this.name = checkpoint.name;
    this.uploadId = checkpoint.uploadId;
    this.uploadParts = checkpoint.uploadParts;
    this.uploadJobs  = checkpoint.uploadJobs;
    this.getPartData = getPartData;
    this.duration = checkpoint.duration;
    // start upload data
    this.resumeUploadJobs();
  },

  resumeUploadJobs: function (partJobIndex) {
    partJobIndex = partJobIndex || 0;
    if (this.uploadJobs.length <= partJobIndex) {
      this.end(this.duration);
      return;
    }
    let partJobStatus = this.uploadJobs[partJobIndex].status;
    let partIndex = this.uploadJobs[partJobIndex].partIndex;
    if (partJobStatus == UploadStatus.failed) {
      this.getPartData(this.uploadId, partIndex).then(partData => {
        this.uploadPart(
          partIndex,
          [partData],
          () => {
            this.resumeUploadJobs(partJobIndex + 1);
          },
          () => {
            this.resumeUploadJobs(partJobIndex + 1);
          }
        );
      })
    } else {
      window.setTimeout(
        () => {
          this.resumeUploadJobs(partJobIndex + 1);
        },
        200
      );
    }
  },

  updateToken: function() {
    this.getToken().then((creds) => {
      this.creds = creds;
      this.store = new OSS({
        region: region,
        accessKeyId: this.creds.AccessKeyId,
        accessKeySecret: this.creds.AccessKeySecret,
        bucket: bucket,
        stsToken: this.creds.SecurityToken
      });
      if (!this.hasReady && this.onReady != null) {
        this.hasReady = true;
        this.onReady();
      }
      console.log("Done init oss_uploader store", this.store);
      this.timer = setTimeout(() => {
        this.updateToken();
      }, 30 * 60 * 1000);
    }).catch((err) => {
      console.error(err);
      if (this.onGetTokenFailed != null) {
        this.onGetTokenFailed("get sts token failed");
      }
    });
  },

  push: function(blobData) {
    if (blobData && blobData.size > 0) {
      this.recordedBlobs.push(blobData);
      if (!this.isUploadProcessRunning) {
        this.uploadProcess();
      }
    }
  },

  uploadProcess: function () {
    // 如果当前没有在init, 同时uploadId等于null, 则出发初始化
    if (this.uploadId == null) {
      this.start();
      this.isUploadProcessRunning = false;
      return;
    }

    // 是否已经完成上传
    if (this.isCompleted) {
      this.isUploadProcessRunning = false;
      return;
    };

    this.isUploadProcessRunning = true; 

    // 判断是否成块，可以开始上传
    // console.log("execute upload process...");
    this.currentPartSize = 0;
    this.currentPartIndex = 0;
    for (let i = 0; i<this.recordedBlobs.length; i++) {
      this.currentPartSize += this.recordedBlobs[i].size;
      this.currentPartIndex = i;
      if (this.currentPartSize >= this.minPartSize) {
        // console.log("trigger upload part, i=" + i);
        this.dataIndex += 1;
        let partData = this.recordedBlobs.splice(0, this.currentPartIndex + 1);
        this.uploadPart(this.dataIndex, partData);
        break;
      }
    }

    this.checkIfAllJobToBeDone();

    this.isUploadProcessRunning = false; 

  },

  checkIfAllJobToBeDone: function() {
    // 检查是否全部分片都上传完成
    if (this.isEnded) {
      if (this.recordedBlobs.length > 0 && !this.isCompleting) {
        console.log("upload the left data");
        this.dataIndex += 1;
        let partData = this.recordedBlobs.splice(0, this.recordedBlobs.length);
        this.uploadPart(this.dataIndex, partData);
      }

      if (this.uploadJobs.every((job) => {return job.status == 1})) {
        console.log("all upload job done success");
        if (this.completeUpload != null) {
          this.completeUpload();
        }
      } else {
        if (this.uploadJobs.every((job) => {return (job.status == 1 || job.status == 2)})) {
          console.log("all upload job done, but some are failed", this.uploadJobs);
          if (this.onCompleteUploadFailed != null) {
            this.onCompleteUploadFailed("not all job are done");
          }
        }
      }
    }
  },

  start: function() {
    if (this.isStarting) return;
    if (this.store == null) {
      console.log("oss_uploader store is null");
      return;
    }
    this.isStarting = true;
    console.log("start", this.store.initMultipartUpload(this.name));
    this.store.initMultipartUpload(
      this.name,
    ).then((res) => {
      // console.log(res);
      this.uploadId = res.uploadId;
      this.isStarting = false;
      this.uploadProcess();
      if (this.onStartUpload != null) {
        this.onStartUpload(res);
      }
    }).catch((err) => {
      console.error(err.name + ': ' + err.message);
      this.isStarting = false;
      if (onFailed != null) {
        onFailed(err);
      }
    });
  },

  uploadPart: function(dataIndex, data, onSuccess, onFailed) {
    if (this.store == null) {
      console.log("oss_uploader store is null");
      return;
    }
    let blobBuffer = new Blob(data, {
      type: 'video/webm'
    });
    if (blobBuffer.size < ossMinPartSize) {
      console.warn("upload part size smaller than ossMinPartSize=", ossMinPartSize);
      if (!this.isUploadProcessRunning) {
        this.uploadProcess();
      }
      return;
    }

    console.log("start upload part, dataIndex=" + dataIndex + ", dataSize=" + blobBuffer.size);
    let curUploadJob = {
      partIndex: dataIndex,
      partSize:  blobBuffer.size,
      status: UploadStatus.uploading
    }
    if (this.uploadJobs.length < dataIndex) {
      this.uploadJobs.push(curUploadJob);
    } else {
      this.uploadJobs[dataIndex-1] = curUploadJob;
    }
    
    this.store.uploadPart(
      this.name, 
      this.uploadId, 
      dataIndex,
      blobBuffer, 
      0, 
      blobBuffer.size
    ).then((part) => {
      console.log("done upload part, dataIndex=" + dataIndex);
      this.uploadParts.push({
        number: dataIndex,
        etag: part.res.headers.etag
      });
      this.uploadJobs[dataIndex-1].status = 1;
      data = null;
      blobBuffer = null;
      if (this.onUploadPart) {
        this.onUploadPart(dataIndex, part);
      }
      if (onSuccess != null) {
        onSuccess(part);
      }
      if (!this.isUploadProcessRunning) {
        this.uploadProcess();
      }
    }).catch((err) => {
      console.error("error upload part, dataIndex=" + dataIndex + ", " + err.name + ': ' + err.message);
      this.uploadJobs[dataIndex-1].status = 2;
      if (this.onUploadPartFailed) {
        this.onUploadPartFailed(dataIndex, blobBuffer);
      }
      if (onFailed != null) {
        onFailed(err);
      }
      if (!this.isUploadProcessRunning) {
        this.uploadProcess();
      }
    });
  },

  end: function (duration) {
    console.log("user end record", duration);

    this.isEnded = true;
    this.duration = duration;
    if (this.timer != null) {
      clearInterval(this.timer);
    }

    if (!this.isUploadProcessRunning) {
      this.uploadProcess();
    }
  },

  abort: function () {
    this.store.abortMultipartUpload(this.name, this.uploadId);
  },

  completeUpload: function() {
    if (this.isCompleting) return;
    console.log("completeUpload", this.uploadParts);
    this.isCompleting = true;
    this.store.completeMultipartUpload(
      this.name,
      this.uploadId,
      this.uploadParts
    ).then((res) => {
      console.log(res);
      this.isCompleted = true;
      this.isCompleting = false;
      if (this.onCompleteUpload != null) {
        this.onCompleteUpload(res);
      }
    }).catch((err) => {
      console.error(err.name + ': ' + err.message);
      this.isCompleted = false;
      this.isCompleting = false;
      if (this.onCompleteUploadFailed != null) {
        this.onCompleteUploadFailed(err);
      }
    });
  }
  
}


// export default AliOssStreamUploader;