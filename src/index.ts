import * as OSS from 'ali-oss';
// import * as OSS from './aliyun-oss-sdk.min.js';
// const path = require("path");

const bucket = 'boom-video-test';
const region = 'oss-cn-shenzhen';
const ossMinPartSize = 102400;
const defaultMaxPartRetryCounts = 1;

// 0 init, 1 done, 2 failed
export const UploadStatus = {
  uploading: 0,
  done: 1,
  failed: 2,
};

export type Options = {
  region?: string;
  bucket?: string;
  minPartSize?: number;
  maxPartRetryCounts?: number;
  timeout?: number;
  mime?: string;
  debug?: boolean;
  // meta?: UserMeta;
  // headers?: object;
};

export type UploadJob = {
  // 分片id
  partIndex: number;
  // 分片大小
  partSize: number;
  // 分片上传状态：0 正在上传，1 上传成功，2上传失败
  status: number;
  // 分片重传累计次数
  retry: number;
};

export type UploadPart = {
  // 分片id
  number: number;
  // 分片etag
  etag: string;
};

export type CheckPoint = {
  name: string;
  uploadId: string | null;
  uploadParts: UploadPart[];
  uploadJobs: UploadJob[];
  duration: number | undefined;
  isEnded: boolean;
  options: Options;
  extraData?: any;
};

export type StsToken = {
  AccessKeyId: string;
  AccessKeySecret: string;
  SecurityToken: string;
};

export type UploadError = {
  name: string;
  message: string;
};

export default class AliOssStreamUploader {
  TAG: string = '[AliOssStreamUploader]';

  // ali oss 对象
  store!: OSS;
  stsToken!: StsToken;

  // oss上的文件名称
  name: string;

  getToken: () => Promise<any>;

  options: Options;

  uploadId!: string;
  uploadParts: UploadPart[] = [];
  uploadJobs: UploadJob[] = [];

  recordedBlobs: Blob[] = [];
  currentPartIndex: number = 0;
  currentPartSize: number = 0;
  dataIndex: number = 0;

  duration: number | undefined;

  // 回调
  onStartUpload!: () => void; // 开始上传初始化成功
  onStartUploadFailed!: (err: UploadError) => void; // 开始上传初始化失败

  onCompleteUpload!: () => void; // 完成上传
  onCompleteUploadFailed!: (err: UploadError) => void; // 完成上传失败

  onUploadPart!: (partIndex: number, part: any) => void; // 上传某个分片成功
  onUploadPartFailed!: (partIndex: number, partData: Blob, error: any) => void; // 上传某个分片失败

  hasReady: boolean = false; // 是否已经执行过onReady
  onReady!: () => void; // oss 对象已经准备好，相当于已经获取到sts token，并且初始化oss对象成功
  onReadyFailed!: (err: any) => void; // getStsToken失败，或者 初始化oss对象失败，或者initMulitUpload失败
  onGetTokenFailed!: (err: any) => void; // 获取sts token失败 callback

  // 获取分片数据函数
  getPartData!: (uploadId: string, partIndex: number) => Promise<Blob>;

  minPartSize: number;

  // 状态
  isStarting: boolean = false;
  isUploadProcessRunning: boolean = false;
  isEnded: boolean = false;
  isCompleted: boolean = false;
  isCompleting: boolean = false;

  // setTimeout handler of updateToken
  timer: any;

  constructor(name: string, getToken: () => Promise<any>, options: Options) {
    this.name = name;
    this.options = options;
    this.uploadParts = [];
    this.uploadJobs = []; // partIndex, partSize, status, retry, backup
    this.recordedBlobs = [];
    this.currentPartIndex = 0;
    this.currentPartSize = 0;
    this.dataIndex = 0;

    this.hasReady = false;

    // 最小分片大小
    this.minPartSize = this.options.minPartSize || 204800;

    // 是否已经初始化成功
    this.isStarting = false;
    this.isUploadProcessRunning = false;
    this.isEnded = false; // 是否主动发起结束
    this.isCompleted = false; // 是否已经完成
    this.isCompleting = false; // 是否正在完成

    this.getToken = getToken;
    this.updateToken();
  }

  // generate checkpoint
  generateCheckpoint(extraData?: any): CheckPoint {
    return {
      name: this.name,
      uploadId: this.uploadId,
      uploadParts: this.uploadParts,
      uploadJobs: this.uploadJobs,
      duration: this.duration,
      isEnded: this.isEnded,
      options: this.options,
      extraData,
    };
  }

  resumeCheckpoint(checkpoint: CheckPoint, getPartData: (uploadId: string, partIndex: number) => Promise<Blob>) {
    // check data
    if (
      !checkpoint.name ||
      !checkpoint.uploadId ||
      !checkpoint.uploadParts ||
      !checkpoint.uploadJobs ||
      !checkpoint.options
    ) {
      if (this.onCompleteUploadFailed) {
        this.onCompleteUploadFailed({
          name: 'CheckpointDataMissing',
          message: 'checkpoint data is not complete',
        });
      }
      return;
    }
    if (getPartData === null) {
      if (this.onCompleteUploadFailed) {
        this.onCompleteUploadFailed({
          name: 'GetPartDataNotProvide',
          message: 'getPartData function not provide',
        });
      }
      return;
    }
    // load data
    this.name = checkpoint.name;
    this.uploadId = checkpoint.uploadId;
    this.uploadParts = checkpoint.uploadParts;
    this.uploadJobs = checkpoint.uploadJobs;
    this.getPartData = getPartData;
    this.duration = checkpoint.duration;
    this.options = checkpoint.options;
    // 检查是否有uploadId
    if (this.uploadId === null || this.uploadId === undefined) {
      this.start((res) => {
        this.resumeUploadJobs();
      });
    } else {
      // start upload data
      this.resumeUploadJobs();
    }
  }

  resumeUploadJobs(partJobIndex: number = 0) {
    this.log('resumeUploadJobs, partJobIndex=' + partJobIndex);
    if (this.getPartData == null) {
      return;
    }
    partJobIndex = partJobIndex || 0;
    if (this.uploadJobs.length <= partJobIndex) {
      this.end(this.duration);
      return;
    }
    const partJobStatus = this.uploadJobs[partJobIndex].status;
    const partIndex = this.uploadJobs[partJobIndex].partIndex;
    if (partJobStatus === UploadStatus.failed || partJobStatus === UploadStatus.uploading) {
      this.getPartData(this.uploadId, partIndex)
        .then((partData: Blob) => {
          this.uploadPart(
            partIndex,
            [partData],
            () => {
              // success
              this.resumeUploadJobs(partJobIndex + 1);
            },
            () => {
              // failed
              this.resumeUploadJobs(partJobIndex + 1);
            },
          );
        })
        .catch((err) => {
          // get part data failed, part data missing, set job to done status
          this.uploadJobs[partJobIndex].status = UploadStatus.done;
          window.setTimeout(() => {
            this.resumeUploadJobs(partJobIndex + 1);
          }, 1);
        });
    } else {
      this.log('resumeUploadJobs, partJobIndex=' + partJobIndex + ', job is done');
      window.setTimeout(() => {
        this.resumeUploadJobs(partJobIndex + 1);
      }, 1);
      // this.resumeUploadJobs(partJobIndex + 1);
    }
  }

  updateToken() {
    this.getToken()
      .then((stsToken: StsToken) => {
        this.stsToken = stsToken;
        this.store = new OSS({
          region: this.options.region || region,
          accessKeyId: this.stsToken.AccessKeyId,
          accessKeySecret: this.stsToken.AccessKeySecret,
          bucket: this.options.bucket || bucket,
          stsToken: this.stsToken.SecurityToken,
        });
        if (!this.hasReady && this.onReady) {
          this.hasReady = true;
          this.onReady();
        }
        this.log('Done init oss_uploader store', this.store);
        this.timer = setTimeout(() => {
          this.updateToken();
        }, 30 * 60 * 1000);
      })
      .catch((err: any) => {
        this.error('updateToken failed', err);
        if (this.onGetTokenFailed) {
          this.onGetTokenFailed('get sts token failed');
        }
        // 获取token失败，并且store还未实例化完成
        if (this.onReadyFailed && !this.store) {
          this.onReadyFailed('get sts token failed');
        }
      });
  }

  push(blobData: Blob) {
    if (blobData && blobData.size > 0) {
      this.recordedBlobs.push(blobData);
      if (!this.isUploadProcessRunning) {
        this.uploadProcess();
      }
    }
  }

  uploadProcess() {
    // 如果当前没有在init, 同时uploadId等于null, 则出发初始化
    if (this.uploadId === null || this.uploadId === undefined) {
      this.start();
      this.isUploadProcessRunning = false;
      return;
    }

    // 是否已经完成上传
    if (this.isCompleted) {
      this.isUploadProcessRunning = false;
      return;
    }

    this.isUploadProcessRunning = true;

    // 判断是否成块，可以开始上传
    this.currentPartSize = 0;
    this.currentPartIndex = 0;
    for (let i = 0; i < this.recordedBlobs.length; i++) {
      this.currentPartSize += this.recordedBlobs[i].size;
      this.currentPartIndex = i;
      if (this.currentPartSize >= this.minPartSize) {
        this.dataIndex += 1;
        const partData = this.recordedBlobs.splice(0, this.currentPartIndex + 1);
        this.uploadPart(this.dataIndex, partData);
        break;
      }
    }

    this.checkIfAllJobToBeDone();

    this.isUploadProcessRunning = false;
  }

  checkIfAllJobToBeDone() {
    // 检查是否全部分片都上传完成
    if (this.isEnded) {
      if (this.recordedBlobs.length > 0 && !this.isCompleting) {
        this.log('upload the left data');
        this.dataIndex += 1;
        const partData = this.recordedBlobs.splice(0, this.recordedBlobs.length);
        this.uploadPart(this.dataIndex, partData);
      }

      if (
        this.uploadJobs.every((job) => {
          return job.status === 1;
        })
      ) {
        this.log('all upload job done success');
        if (this.completeUpload) {
          this.completeUpload();
        }
      } else {
        if (
          this.uploadJobs.every((job) => {
            return job.status === 1 || job.status === 2;
          })
        ) {
          this.log('all upload job done, but some are failed', this.uploadJobs);
          if (this.onCompleteUploadFailed) {
            this.onCompleteUploadFailed({
              name: 'NotAllJobDone',
              message: 'not all job done, some are failed',
            });
          }
        }
      }
    }
  }

  start(onSuccess?: (res: any) => void, onFailed?: (err: string) => void) {
    if (this.isStarting) return;
    if (this.store === null || this.store === undefined) {
      this.log('oss_uploader store is null');
      return;
    }
    this.isStarting = true;
    this.log('start, initMultipartUpload');
    this.store
      .initMultipartUpload(this.name)
      .then((res: any) => {
        this.uploadId = res.uploadId;
        this.isStarting = false;
        if (onSuccess) {
          onSuccess(res);
        }
        this.uploadProcess();
        if (this.onStartUpload) {
          this.onStartUpload();
        }
      })
      .catch((err: any) => {
        this.error(err.name + ': ' + err.message);
        this.isStarting = false;
        if (onFailed) {
          onFailed(err);
        }
        if (this.onStartUploadFailed) {
          this.onStartUploadFailed(err);
        }
        if (this.onReadyFailed) {
          this.onReadyFailed('initMultipartUpload failed');
        }
      });
  }

  uploadPart(dataIndex: number, data: Blob[], onSuccess?: (res: any) => void, onFailed?: (err: string) => void) {
    if (this.store === null || this.store === undefined) {
      this.log('oss_uploader store is null');
      return;
    }
    let blobBuffer: Blob = new Blob(data, {
      type: 'video/webm',
    });
    /// 取消兜底，不拦截小数据
    // if (blobBuffer.size < ossMinPartSize) {
    //   this.warn('upload part size smaller than ossMinPartSize=', ossMinPartSize);
    //   if (!this.isUploadProcessRunning) {
    //     this.uploadProcess();
    //   }
    //   return;
    // }

    this.log('start upload part, dataIndex=' + dataIndex + ', dataSize=' + blobBuffer.size);
    if (this.uploadJobs.length < dataIndex) {
      const curUploadJob: UploadJob = {
        partIndex: dataIndex,
        partSize: blobBuffer.size,
        status: UploadStatus.uploading,
        retry: 1,
      };
      this.uploadJobs.push(curUploadJob);
    } else {
      this.uploadJobs[dataIndex - 1].status = UploadStatus.uploading;
    }

    this.store
      .uploadPart(this.name, this.uploadId as string, dataIndex, blobBuffer, 0, blobBuffer.size)
      .then((part) => {
        this.log('done upload part, dataIndex=' + dataIndex);
        this.uploadParts.push({
          number: dataIndex,
          etag: (part.res.headers as any).etag,
        });
        this.uploadJobs[dataIndex - 1].status = 1;
        data = [];
        blobBuffer = {} as Blob;
        if (this.onUploadPart) {
          this.onUploadPart(dataIndex, part);
        }
        if (onSuccess) {
          onSuccess(part);
        }
        if (!this.isUploadProcessRunning) {
          this.uploadProcess();
        }
      })
      .catch((err) => {
        this.error('error upload part, dataIndex=' + dataIndex + ', ' + err.name + ': ' + err.message);

        if (this.uploadJobs[dataIndex - 1].retry >= (this.options.maxPartRetryCounts || defaultMaxPartRetryCounts)) {
          // 超过分片最大重传次数
          this.uploadJobs[dataIndex - 1].status = 2;
          if (this.onUploadPartFailed) {
            this.onUploadPartFailed(dataIndex, blobBuffer, err);
          }
          if (onFailed) {
            onFailed(err);
          }
          if (!this.isUploadProcessRunning) {
            this.uploadProcess();
          }
        } else {
          this.uploadJobs[dataIndex - 1].retry = this.uploadJobs[dataIndex - 1].retry + 1;
          this.uploadPart(dataIndex, data, onSuccess, onFailed);
        }
      });
  }

  end(duration?: number) {
    this.log('user end record', duration);

    this.isEnded = true;
    this.duration = duration;
    if (this.timer) {
      clearInterval(this.timer);
    }

    if (!this.isUploadProcessRunning) {
      this.uploadProcess();
    }
  }

  abort(): Promise<any> {
    return this.store.abortMultipartUpload(this.name, this.uploadId as string);
  }

  completeUpload() {
    if (this.isCompleting) return;
    this.log('completeUpload', this.uploadParts);
    this.isCompleting = true;
    this.store
      .completeMultipartUpload(this.name, this.uploadId, this.uploadParts)
      .then((res: any) => {
        this.log('completeUpload success', res);
        this.isCompleted = true;
        this.isCompleting = false;
        if (this.onCompleteUpload) {
          this.onCompleteUpload();
        }
      })
      .catch((err: any) => {
        this.error(err.name + ': ' + err.message);
        this.isCompleted = false;
        this.isCompleting = false;
        if (this.onCompleteUploadFailed) {
          this.onCompleteUploadFailed(err);
        }
      });
  }

  // upload buffer to object storage
  uploadBuffer(remotePath: string, bufferData: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.store
        .put(remotePath, bufferData)
        .then((result) => {
          resolve(result);
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  log(content: string, extraData?: any) {
    if (!this.options.debug) return;
    console.log(this.TAG, content, extraData);
  }
  error(content: string, extraData?: any) {
    if (!this.options.debug) return;
    console.error(this.TAG, content, extraData);
  }
  warn(content: string, extraData?: any) {
    if (!this.options.debug) return;
    console.warn(this.TAG, content, extraData);
  }
}
