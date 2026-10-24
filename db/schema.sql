CREATE TABLE content (
  contentID     INT PRIMARY KEY,
  name          VARCHAR(50) NOT NULL,
  cooldownType  TINYINT NOT NULL COMMENT '0 interval, 1 dailyReset',
  intervalSec   INT NULL COMMENT 'interval일 때만',
  resetTimesKST JSON NULL COMMENT 'dailyReset일 때. ["00:00"] 형식, 한국 시간',
  adFormat      TINYINT NOT NULL COMMENT '0 video, 1 install',
  rewardType    TINYINT NOT NULL COMMENT '0 point, 1 ticket',
  rewardAmount  INT NOT NULL
);

CREATE TABLE user_content_state (
  userID          BIGINT NOT NULL,
  contentID       INT NOT NULL,
  lastRewardAt    DATETIME(3) NULL,
  nextAvailableAt DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
  PRIMARY KEY (userID, contentID)
);

CREATE TABLE ad_impression (
  impressionID BIGINT AUTO_INCREMENT PRIMARY KEY,
  userID       BIGINT NOT NULL,
  contentID    INT NOT NULL,
  adFormat     TINYINT NOT NULL,
  advertiser   VARCHAR(50) NOT NULL,
  campaign     VARCHAR(50) NULL,
  startedAt    DATETIME(3) NOT NULL,
  completedAt  DATETIME(3) NULL,
  used         TINYINT NOT NULL DEFAULT 0,
  KEY idx_user_started (userID, startedAt)
);

CREATE TABLE reward (
  rewardID     BIGINT AUTO_INCREMENT PRIMARY KEY,
  userID       BIGINT NOT NULL,
  contentID    INT NOT NULL,
  rewardType   TINYINT NOT NULL,
  amount       INT NOT NULL,
  impressionID BIGINT NOT NULL,
  createdAt    DATETIME(3) NOT NULL,
  UNIQUE KEY uq_impression (impressionID),
  KEY idx_user_created (userID, createdAt)
);

CREATE TABLE event_log (
  eventID    BIGINT AUTO_INCREMENT PRIMARY KEY,
  userID     BIGINT NOT NULL,
  eventType  VARCHAR(30) NOT NULL,
  contentID  INT NULL,
  occurredAt DATETIME(3) NOT NULL,
  payload    JSON NULL,
  KEY idx_type_time (eventType, occurredAt),
  KEY idx_user_time (userID, occurredAt)
);
