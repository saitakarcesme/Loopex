// Read-only session membership: PID/SID census, then identity only for this owned session.
// No process names, arguments, environment, file paths, signals or permission requests.
#include <libproc.h>
#include <sys/proc_info.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <limits.h>

static int failure(const char *message) { fprintf(stderr, "%s (%d)\n", message, errno); return 1; }
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end = NULL;
  long parsed = strtol(argv[1], &end, 10);
  if (!end || *end || parsed <= 1 || parsed > INT_MAX) return 2;
  pid_t session = (pid_t)parsed;
  int capacity = 4096, bytes = 0;
  pid_t *pids = NULL;
  for (;;) {
    if (capacity > 1048576) { errno = EOVERFLOW; free(pids); return failure("PID census exceeded its bound"); }
    free(pids); pids = calloc((size_t)capacity, sizeof(pid_t));
    if (!pids) return failure("PID census allocation failed");
    bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, capacity * (int)sizeof(pid_t));
    if (bytes < 0) { free(pids); return failure("PID census failed"); }
    if (bytes == 0) { free(pids); errno = EIO; return failure("PID census returned no evidence"); }
    if (bytes < capacity * (int)sizeof(pid_t)) break;
    capacity *= 2;
  }
  // Accumulate before printing so a partial read never looks like a complete snapshot.
  struct proc_bsdinfo *members = calloc((size_t)capacity, sizeof(struct proc_bsdinfo));
  if (!members) { free(pids); return failure("Session allocation failed"); }
  int count = 0;
  for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
    pid_t pid = pids[i];
    if (pid <= 1) continue;
    errno = 0; pid_t sid = getsid(pid);
    if (sid < 0) { if (errno == ESRCH) continue; free(pids); free(members); return failure("Session membership read is uncertain"); }
    if (sid != session) continue;
    struct proc_bsdinfo info = {0};
    errno = 0;
    int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (size != sizeof(info)) {
      if (getsid(pid) < 0 && errno == ESRCH) continue;
      free(pids); free(members); return failure("Owned process identity read is uncertain");
    }
    errno = 0; sid = getsid(pid);
    if (sid < 0 && errno == ESRCH) continue;
    if (sid != session) { free(pids); free(members); return failure("Owned process session changed during observation"); }
    members[count++] = info;
  }
  printf("{\"sessionId\":%d,\"members\":[", session);
  for (int i = 0; i < count; i++) {
    struct proc_bsdinfo *member = &members[i];
    printf("%s{\"pid\":%u,\"pgid\":%u,\"birth\":\"%llu:%llu\"}", i ? "," : "", member->pbi_pid, member->pbi_pgid, (unsigned long long)member->pbi_start_tvsec, (unsigned long long)member->pbi_start_tvusec);
  }
  puts("]}"); free(pids); free(members); return 0;
}
