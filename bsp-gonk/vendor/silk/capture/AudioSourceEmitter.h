#pragma once

#include <media/stagefright/foundation/ABase.h>
#include <media/stagefright/MediaSource.h>
#include <utils/StrongPointer.h>

using namespace android;
namespace capture {
namespace datasocket {
class Channel;
}
}

class AudioSourceEmitter: public MediaSource {
 public:
  AudioSourceEmitter(
    const sp<MediaSource> &source,
    capture::datasocket::Channel *channel,
    int audioSampleRate,
    int audioChannels,
    bool vadEnabled = false
  );
  virtual ~AudioSourceEmitter();
  virtual status_t start(MetaData *params = NULL);
  virtual status_t stop();
  virtual sp<MetaData> getFormat();
  virtual status_t read(MediaBuffer **buffer, const ReadOptions *options);

 private:
  sp<MediaSource> mSource;
  capture::datasocket::Channel *mChannel;
  bool mVadEnabled;
  uint8_t *mAudioBuffer;
  uint32_t mAudioBufferIdx;
  uint32_t mAudioBufferLen;
  bool mAudioBufferVad;

  bool vadCheck();

  DISALLOW_EVIL_CONSTRUCTORS(AudioSourceEmitter);
};

