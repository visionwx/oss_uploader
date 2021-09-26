import AliOssStreamUploader from '../index';

test('AliOssStreamUploader Init', () => {
  let name: string = 'test.mp4';
  let getToken: () => Promise<any> = () => {
    return new Promise(function (resolve, reject) {
      resolve({
        AccessKeyId: 'string',
        AccessKeySecret: 'string',
        SecurityToken: 'string',
      });
    });
  };
  expect(new AliOssStreamUploader(name, getToken, { minPartSize: 204800 }).name).toBe('test.mp4');
});
