LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)

LOCAL_MODULE := silk-dhcputil
LOCAL_MODULE_STEM := dhcputil
LOCAL_MODULE_TAGS := optional
LOCAL_SRC_FILES := main.cpp
LOCAL_CFLAGS += -Werror -Wextra
LOCAL_C_INCLUDES += system/core/include
LOCAL_SHARED_LIBRARIES := \
  libcutils \
  liblog \
  libnetutils \

ifneq ($(TARGET_GE_MARSHMALLOW),)
LOCAL_CFLAGS += -DTARGET_GE_MARSHMALLOW
endif

ifneq ($(TARGET_GE_NOUGAT),)
LOCAL_CLANG := false
LOCAL_CFLAGS += -DTARGET_GE_NOUGAT
endif

include $(BUILD_SILK_EXECUTABLE)
