OSS Uploader

#### ToDo
- resumeCheckpoint的时候，如果uploadPart的状态是0，也尝试获取数据并重传，如果没有get到数据，则修改状态为2
- aws s3 支持

#### Change
##### 2021-02-16
* 更新接口至v2
##### 2021-01-04
- 优化ali-oss引入方式，直接使用aliyun-oss-sdk.min.js, 解决node引入的代码压缩错误

#####  2021-12-31
- resumeCheckpoint的时候，如果uploadPart的状态是0，也尝试获取数据并重传，如果没有get到数据，则修改状态为2
- 增加uploadBuffer接口

#####  2021-09-27
- 支持 initMultiUploader 失败的 checkpoint, 既没有 uploadId时，自动重新 initMultiUpload
- generateCheckpoint的时候 支持传入extraData 保存额外信息
- export所有type
- options 增加 debug参数，开启关闭日志
- resumeUploadJob 去掉setTimeout机制

#####  2021-09-26
- end 函数增加 duration 可选入参。用于记录录制时长，这个参数值 会保存到checkpoint对象当中
- uploadPart 增加 最小分片 102400 判断
- 将end之后 的 分片收尾处理逻辑 移到 checkIfAllJobToBeDone 函数
- 调整updateToken逻辑，由setInterval改成setTimout
- 增加getTokenFailed回调，当获取sts token失败时出发
- 增加onReady回调，当获取初始化oss对象成功时出发
- 增加checkpoint逻辑， generateCheckpoint用于生成checkpoint，resumeCheckpoint用于恢复checkpoint


#### 推流上传例子：
```
function initOssUploader() {
    let ossFileName = OSS_FOLDER + USER_INFO._id + "_" + (new Date().getTime()) + "_main.mp4"
    oss_uploader = new AliOssStreamUploader(
        ossFileName,
        getOssStsToken,
        {
            minPartSize: 204800
        }
    );
    oss_uploader.onCompleteUpload = () => {
        console.log(oss_uploader.generateCheckpoint());
        let videoClient = new VideoClient();
        let videoName = "Screen Recording at " + formatDate(new Date().getTime());
        let videoSrc = OSS_DOMAIN + "/" + ossFileName;
        let videoCover = videoSrc.replace(".mp4", "/1.png");
        let videoTime = media_record_seconds;
        videoClient.create(
            USER_INFO._id,
            videoName,
            videoSrc,
            videoTime,
            videoCover,
            videoName,
            (video_id) => {
              console.log("create video success");
              window.open("https://" + DOMAIN + "/#/videodetail?videoId=" + video_id);
            },
            (error) => {
              console.error(error);
            },
        )
    }
    oss_uploader.onCompleteUploadFailed = () => {
        console.error("onCompleteUploadFailed");
        initOssResumeUploader(oss_uploader.generateCheckpoint());
    }
    oss_uploader.onUploadPartFailed = (partIndex, partData) => {
        console.error("onUploadPartFailed", partIndex, partData);
        media_record_buffer[oss_uploader.uploadId + "_" + partIndex] = partData;
    }
}

function getOssStsToken() {
    return new Promise(function(resolve, reject) {
        chrome.cookies.get({
            url: "https://www.visionwx.com/",
            name: TOKEN_FIELD_NAME
        }, function(token) {
            console.log(token);
            if (token == null || token.value == "" || token.value == null) {
                // 用户未登录情况处理
                console.error("user token not found");
                reject("tokenNotFound");
            } else {
                // 用户已经登录情况处理，根据token获取用户信息
                $.ajax({
                    url: APIS.oss_token,
                    type: 'GET',
                    headers: {
                        authorization: token.value,
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
    });
}

# 不断推送blob
oss_uploader.push(blobData)
# 结束录制，并传入录制时长
oss_uploader.end(34)
# 取消录制
oss_uploader.abort()
```



#### 恢复推流上传例子：
```
function initOssResumeUploader(checkpoint) {
    console.log(checkpoint);
    let oss_resume_uploader = new AliOssStreamUploader(
        "resume",
        getOssStsToken,
        {
            minPartSize: 204800
        }
    );
    oss_resume_uploader.onCompleteUpload = () => {
        let videoClient = new VideoClient();
        let videoName = "Screen Recording at " + formatDate(new Date().getTime());
        let videoSrc = OSS_DOMAIN + "/" + oss_resume_uploader.name;
        let videoCover = videoSrc.replace(".mp4", "/1.png");
        let videoTime = checkpoint.duration;
        videoClient.create(
            USER_INFO._id,
            videoName,
            videoSrc,
            videoTime,
            videoCover,
            videoName,
            (video_id) => {
              console.log("create video success");
              window.open("https://" + DOMAIN + "/#/videodetail?videoId=" + video_id);
            },
            (error) => {
              console.error(error);
            },
        )
    }
    oss_resume_uploader.onCompleteUploadFailed = (err) => {
        console.error("onCompleteUploadFailed", err);
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

```