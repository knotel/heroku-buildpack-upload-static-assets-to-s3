var AWS = require('aws-sdk');
var glob = require('glob');
var path = require('path');
var fs = require('fs');
var _ = require('lodash');
var async = require('async');
var mimeTypes = require('mime-types');
var shelljs = require('shelljs');

function getEnvVariable(name) {
  try {
    return process.env[name] || fs.readFileSync(path.join(process.env.ENV_DIR, name), {encoding: 'utf8'});
  } catch(error) {
    console.error('Could not find: ' + name);
  }
}

try {

  AWS.config.maxRetries = 10;

  AWS.config.accessKeyId = getEnvVariable('AWS_ACCESS_KEY_ID');
  AWS.config.secretAccessKey = getEnvVariable('AWS_SECRET_ACCESS_KEY');
  AWS.config.region = getEnvVariable('AWS_DEFAULT_REGION');

  // bucket where static assets are uploaded to
  var AWS_STATIC_BUCKET_NAME = getEnvVariable('AWS_STATIC_BUCKET_NAME');
  // the source directory of static assets
  var AWS_STATIC_SOURCE_DIRECTORY = getEnvVariable('AWS_STATIC_SOURCE_DIRECTORY');
  // the prefix assigned to the path, can be used to configure routing rules in CDNs
  var AWS_STATIC_PREFIX = getEnvVariable('AWS_STATIC_PREFIX');

} catch(error) {
  console.error('Static Uploader is not configured for this deploy');
  console.error(error);
  console.error('Exiting without error');
  process.exit(0);
}

var keys = Object.keys(process.env);
// the sha-1 or version supplied by heroku used to version builds in the path
var SOURCE_VERSION = process.env.SOURCE_VERSION;
var BUILD_DIR = process.env.BUILD_DIR;

// location of public assets in the heroku build environment
var PUBLIC_ASSETS_SOURCE_DIRECTORY = path.join(BUILD_DIR, AWS_STATIC_SOURCE_DIRECTORY);

// uploaded files are prefixed with this to enable versioning
var STATIC_PATH = path.join(AWS_STATIC_PREFIX)

var HEROKU_APP_NAME = getEnvVariable('HEROKU_APP_NAME');

if (HEROKU_APP_NAME !== undefined) {
  fs.renameSync(
    PUBLIC_ASSETS_SOURCE_DIRECTORY + '/asset-manifest.json',
    PUBLIC_ASSETS_SOURCE_DIRECTORY + '/' + HEROKU_APP_NAME + '.json',
    function(err) {
      if ( err ) console.log('ERROR: ' + err);
  });
};

glob(PUBLIC_ASSETS_SOURCE_DIRECTORY + '/**', {}, function(error, files) {
    if (error || !files) {
      return process.exit(1);
    }

    console.log('Files to Upload:', files.length);
    console.time('Upload Complete In');

    var yearInMs = 365 * 24 * 60 * 60000;
    var yearFromNow = Date.now() + yearInMs;

    var s3 = new AWS.S3();
    async.eachLimit(files, 16, function(file, callback) {
        var stat = fs.statSync(file);

        if (!stat.isFile()) {
          return callback(null);
        }

        const shortFile = file.replace(PUBLIC_ASSETS_SOURCE_DIRECTORY, '')
        const dirname = path.dirname(shortFile)
        const filename = path.basename(shortFile)

        const params = {
          ACL: 'public-read',
          Key: path.join(STATIC_PATH, filename),
          Body: fs.createReadStream(file),
          Bucket: dirname.length > 1 ? path.join(AWS_STATIC_BUCKET_NAME, dirname) : AWS_STATIC_BUCKET_NAME,
          Expires: new Date(yearFromNow),
          CacheControl: 'public,max-age=' + yearInMs + ',smax-age=' + yearInMs,
        }

        if (params.Key.toLowerCase().lastIndexOf('.gz') === params.Key.length - 3) {
          params.Key = params.Key.slice(0, params.Key.length - 3)
          params.ContentEncoding = 'gzip'
          params.Metadata = {
            'Content-Encoding' : 'gzip'
          }
        }

        if (params.Key[0] === '/') {
          params.Key = params.Key.slice(1)
        }

        var contentType = mimeTypes.lookup(path.extname(params.Key)) || null;
        if (!_.isString(contentType)) {
          console.warn('Unknown ContentType:', contentType, file);
          contentType = 'application/octet-stream';
        }
        params.ContentType = contentType

        if (params.Key === 'index.html') {
          params.CacheControl = 'no-store, no-cache, must-revalidate'
        }

        console.log('Uploading File: ' + params.Key + (params.ContentEncoding ? ' (' + params.ContentEncoding + ')': ''))

        s3.upload(params, callback)
      },
      function onUploadComplete(error) {
        console.timeEnd('Upload Complete In');

        if (error) {
          console.error('Static Uploader failed to upload to S3');
          console.error(error);
          console.error('Exiting without error');
          process.exit(0);
        }

        var profiled = process.env.BUILD_DIR + '/.profile.d';
        fs.writeFileSync(
          path.join(profiled, '00-upload-static-files-to-s3-export-env.sh'),
          'echo EXPORTING STATIC ENV VARIABLES\n' +
          'export STATIC_SERVER=${STATIC_SERVER:-' + AWS_STATIC_BUCKET_NAME + '.s3.amazonaws.com' + '}\n' +
          'export STATIC_PATH=${STATIC_PATH:-/' + STATIC_PATH + '}\n',
          {encoding: 'utf8'}
        );

        process.exit(0);
      });
  }
);

