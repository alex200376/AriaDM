/**
 * aria2 error code table.
 *
 * Sourced from the "EXIT STATUS" / `errorCode` table in the aria2 1.37.0 manual.
 * `errorCode` values surface both from the RPC `tellStatus` result and from
 * process exit codes, so they are worth mapping to something a human can act on.
 */

export interface Aria2ErrorInfo {
  code: number
  short: string
  detail: string
  /** Whether retrying has any reasonable chance of succeeding. */
  retryable: boolean
}

export const ARIA2_ERRORS: Record<number, Aria2ErrorInfo> = {
  0: { code: 0, short: '無錯誤', detail: '下載成功完成。', retryable: false },
  1: { code: 1, short: '未知錯誤', detail: 'aria2 回報未知錯誤，通常是暫時性的網路問題。', retryable: true },
  2: { code: 2, short: '連線逾時', detail: '與伺服器連線逾時。請確認網路狀態或稍後重試。', retryable: true },
  3: { code: 3, short: '找不到資源', detail: '伺服器回應 404，資源不存在或已被移除。', retryable: false },
  4: { code: 4, short: '連續找不到檔案', detail: '連續多次收到檔案不存在，已達 --max-file-not-found 上限。', retryable: false },
  5: { code: 5, short: '速度過慢', detail: '下載速度低於 --lowest-speed-limit 設定，連線已被關閉。', retryable: true },
  6: { code: 6, short: '網路問題', detail: '發生網路錯誤，例如無法解析主機或連線中斷。', retryable: true },
  7: { code: 7, short: '有未完成的下載', detail: 'aria2 結束時仍有未完成的下載。', retryable: true },
  8: { code: 8, short: '不支援續傳', detail: '遠端伺服器不支援續傳，但此下載需要續傳。', retryable: false },
  9: { code: 9, short: '磁碟空間不足', detail: '可用磁碟空間不足以下載此檔案。請清出空間後重試。', retryable: false },
  10: { code: 10, short: '分片長度不符', detail: '分片長度與 .aria2 控制檔中記錄的不同。', retryable: false },
  11: { code: 11, short: '正在下載相同檔案', detail: '同一檔案已在下載中。', retryable: false },
  12: { code: 12, short: '正在下載相同種子', detail: '相同的 info hash 種子已在下載中。', retryable: false },
  13: { code: 13, short: '檔案已存在', detail: '目標檔案已存在，且未啟用覆寫或自動更名。', retryable: false },
  14: { code: 14, short: '更名失敗', detail: '檔案更名失敗。', retryable: true },
  15: { code: 15, short: '無法開啟檔案', detail: '無法開啟既有檔案，可能被其他程式佔用。', retryable: true },
  16: { code: 16, short: '無法建立檔案', detail: '無法建立或截斷檔案，請確認寫入權限與路徑是否合法。', retryable: false },
  17: { code: 17, short: '檔案 I/O 錯誤', detail: '讀寫檔案時發生 I/O 錯誤，常見於磁碟問題或防毒軟體干擾。', retryable: true },
  18: { code: 18, short: '無法建立目錄', detail: '無法建立儲存目錄，請確認路徑與寫入權限。', retryable: false },
  19: { code: 19, short: '名稱解析失敗', detail: '無法解析主機名稱。請檢查 DNS 或代理設定。', retryable: true },
  20: { code: 20, short: 'Metalink 解析失敗', detail: '無法解析 Metalink 文件。', retryable: false },
  21: { code: 21, short: 'FTP 指令失敗', detail: 'FTP 指令執行失敗。', retryable: true },
  22: { code: 22, short: 'HTTP 標頭異常', detail: 'HTTP 回應標頭異常或非預期。伺服器可能不支援分段下載。', retryable: true },
  23: { code: 23, short: '重新導向過多', detail: '重新導向次數超過上限。', retryable: false },
  24: { code: 24, short: '認證失敗', detail: 'HTTP 認證失敗，請確認使用者名稱與密碼。', retryable: false },
  25: { code: 25, short: 'Bencode 解析失敗', detail: '無法解析 bencoded 檔案，種子檔可能損毀。', retryable: false },
  26: { code: 26, short: '種子檔損毀', detail: '種子檔損毀或缺少必要資訊。', retryable: false },
  27: { code: 27, short: 'Magnet 連結無效', detail: 'Magnet URI 格式錯誤。', retryable: false },
  28: { code: 28, short: '無法辨識的選項', detail: '傳入了無法辨識的 aria2 選項。', retryable: false },
  29: { code: 29, short: '伺服器過載', detail: '遠端伺服器因暫時過載無法處理請求，請稍後重試。', retryable: true },
  30: { code: 30, short: 'JSON-RPC 解析失敗', detail: '無法解析 JSON-RPC 請求。', retryable: false },
  31: { code: 31, short: '保留碼', detail: 'aria2 保留的錯誤碼。', retryable: false },
  32: { code: 32, short: '檢查碼不符', detail: '檔案檢查碼驗證失敗，下載內容與預期不符。', retryable: true }
}

export function describeAria2Error(code: number, fallbackMessage = ''): Aria2ErrorInfo {
  const known = ARIA2_ERRORS[code]
  if (known) {
    if (fallbackMessage && code !== 0) {
      return { ...known, detail: `${known.detail}（${fallbackMessage}）` }
    }
    return known
  }
  return {
    code,
    short: `錯誤 ${code}`,
    detail: fallbackMessage || 'aria2 回報了未收錄的錯誤碼。',
    retryable: code !== 3 && code !== 13
  }
}

export function isRetryableError(code: number): boolean {
  return describeAria2Error(code).retryable
}
