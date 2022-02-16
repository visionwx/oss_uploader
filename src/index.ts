import * as OSS from 'ali-oss';
// import * as OSS from './aliyun-oss-sdk.min.js';
// const path = require("path");

const bucket = 'boom-upload-test';
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
  accessKeyId: string;
  accessKeySecret: string;
  stsToken: string;
};

export type UploadError = {
  name: string;
  message: string;
};

export const CallbackName = {
  uploading: 0,
  done: 1,
  failed: 2,
};

export default class AliOssStreamUploader {
  TAG: string = '[AliOssStreamUploader]';

  // ali oss 对象
  store!: OSS;
  stsToken!: StsToken;

  // oss上的文件名称
  name: string;
  uploadId: string;

  getToken: () => Promise<{
    accessKeyId: string;
    accessKeySecret: string;
    stsToken: string;
  }>;

  options: Options;

  uploadParts: UploadPart[] = [];
  uploadJobs: UploadJob[] = [];

  recordedBlobs: Blob[] = [];
  currentPartIndex: number = 0;
  currentPartSize: number = 0;
  dataIndex: number = 0;

  duration: number | undefined;

  // 回调
  onStartUpload?: () => void; // 开始上传初始化成功
  onStartUploadFailed?: (err: UploadError) => void; // 开始上传初始化失败

  onCompleteUpload?: () => void; // 完成上传
  onCompleteUploadFailed?: (err: UploadError) => void; // 完成上传失败

  onUploadPart?: (partIndex: number, part: any) => void; // 上传某个分片成功
  onUploadPartFailed?: (partIndex: number, partData: Blob, error: any) => void; // 上传某个分片失败

  hasReady: boolean = false; // 是否已经执行过onReady
  onReady?: () => void; // oss 对象已经准备好，相当于已经获取到sts token，并且初始化oss对象成功
  onReadyFailed?: (errorDescription: string) => void; // getStsToken失败，或者 初始化oss对象失败，或者initMulitUpload失败
  onGetTokenFailed?: (errorDescription: string) => void; // 获取sts token失败 callback

  // 获取分片数据函数
  getPartData?: (uploadId: string, partIndex: number) => Promise<Blob>;

  minPartSize: number;

  // 状态
  isStarting: boolean = false;
  isUploadProcessRunning: boolean = false;
  isEnded: boolean = false;
  didAbort = false;

  // setTimeout handler of updateToken
  timer: any;

  constructor(
    name: string,
    uploadId: string,
    getToken: () => Promise<{
      accessKeyId: string;
      accessKeySecret: string;
      stsToken: string;
    }>,
    options: Options,
  ) {
    this.name = name;
    this.uploadId = uploadId;
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
    if (this.uploadId) {
      this.resumeUploadJobs();
    }
  }

  async resumeUploadJobs(partJobIndex: number = 0) {
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
      try {
        const partData = await this.getPartData(this.uploadId, partIndex);
        try {
          await this.uploadPart(partIndex, [partData]);
        } catch {}
        this.resumeUploadJobs(partJobIndex + 1);
      } catch (err) {
        // get part data failed, part data missing, set job to done status
        this.uploadJobs[partJobIndex].status = UploadStatus.done;
        await this.resumeUploadJobs(partJobIndex + 1);
      }
    } else {
      this.log('resumeUploadJobs, partJobIndex=' + partJobIndex + ', job is done');
      await this.resumeUploadJobs(partJobIndex + 1);
    }
  }

  async updateToken() {
    try {
      const { accessKeyId, accessKeySecret, stsToken } = await this.getToken();
      console.log({ accessKeyId, accessKeySecret, stsToken });
      this.store = new OSS({
        region: this.options.region || region,
        accessKeyId: accessKeyId,
        accessKeySecret: accessKeySecret,
        bucket: this.options.bucket || bucket,
        stsToken: stsToken,
        refreshSTSToken: this.getToken,
        refreshSTSTokenInterval: 1000 * 60 * 50, // 每50分钟refresh
      });
      if (!this.hasReady && this.onReady) {
        this.hasReady = true;
        this.onReady();
      }
      this.log('Done init oss_uploader store', this.store);
    } catch (err) {
      this.error('updateToken failed', err);
      if (this.onGetTokenFailed) {
        this.onGetTokenFailed('get sts token failed');
      }
      // 获取token失败，并且store还未实例化完成
      if (this.onReadyFailed && !this.store) {
        this.onReadyFailed('get sts token failed');
      }
    }
  }

  push(blobData: Blob) {
    console.log(this.isUploadProcessRunning);
    if (blobData && blobData.size > 0) {
      this.recordedBlobs.push(blobData);
      // 保证每次只有一个uploadProcess在进行
      if (!this.isUploadProcessRunning) {
        this.uploadProcess();
      }
    }
  }

  async uploadProcess() {
    if (this.didAbort) return;

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
        try {
          await this.uploadPart(this.dataIndex, partData);
        } catch {}
        break;
      }
    }

    if (this.isEnded) {
      this.checkIfAllJobToBeDone();
    }

    this.isUploadProcessRunning = false;
  }

  // 检查是否全部分片都上传完成
  checkIfAllJobToBeDone() {
    if (this.recordedBlobs.length > 0) {
      this.log('upload the left data');
      this.dataIndex += 1;
      const partData = this.recordedBlobs.splice(0, this.recordedBlobs.length);
      this.uploadPart(this.dataIndex, partData);
    }

    if (
      this.uploadJobs.every((job) => {
        return job.status === UploadStatus.done;
      })
    ) {
      this.log('all upload job done success');
      if (this.onCompleteUpload) {
        this.onCompleteUpload();
      }
    } else {
      if (
        this.uploadJobs.every((job) => {
          return job.status === UploadStatus.done || job.status === UploadStatus.failed;
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

  /**
   * 每一个分片上传函数
   * @param dataIndex 分片索引
   * @param data 分片数据
   * @returns Promise<OSS.UploadPartResult>
   */
  async uploadPart(dataIndex: number, data: Blob[]): Promise<OSS.UploadPartResult> {
    if (this.store === null || this.store === undefined) {
      this.log('oss_uploader store is null');
      throw 'oss_uploader store is null';
    }
    let blobBuffer: Blob = new Blob(data, {
      type: 'video/webm',
    });

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

    try {
      const part = await this.store.uploadPart(this.name, this.uploadId, dataIndex, blobBuffer, 0, blobBuffer.size);
      this.log('done upload part, dataIndex=' + dataIndex);
      this.uploadParts.push({
        number: dataIndex,
        etag: (part.res.headers as any).etag,
      });
      this.uploadJobs[dataIndex - 1].status = UploadStatus.done;
      data = [];
      blobBuffer = {} as Blob;
      if (this.onUploadPart) {
        this.onUploadPart(dataIndex, part);
      }

      if (!this.isUploadProcessRunning) {
        this.uploadProcess();
      }
      return part;
    } catch (err: any) {
      this.error('error upload part, dataIndex=' + dataIndex + ', ' + err.name + ': ' + err.message);
      // 超过分片最大重传次数 - throw
      if (this.uploadJobs[dataIndex - 1].retry >= (this.options.maxPartRetryCounts || defaultMaxPartRetryCounts)) {
        this.uploadJobs[dataIndex - 1].status = UploadStatus.failed;
        if (this.onUploadPartFailed) {
          this.onUploadPartFailed(dataIndex, blobBuffer, err);
        }
        if (!this.isUploadProcessRunning) {
          this.uploadProcess();
        }
        throw err;
      } else {
        this.uploadJobs[dataIndex - 1].retry = this.uploadJobs[dataIndex - 1].retry + 1;
        return await this.uploadPart(dataIndex, data);
      }
    }
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

  /// 检查所有的分片都停之后再resolve
  abort(): Promise<boolean> {
    this.didAbort = true;
    // 轮训检查isUploadProcessRunning，为false才resolve
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (!this.isUploadProcessRunning) {
          clearInterval(interval);
          resolve(true);
        }
      }, 100);
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
