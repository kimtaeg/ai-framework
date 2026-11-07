// k6 한계 찾기: k6-mixed.js 와 같은 요청 섞기를, 초당 반복 수를 계단식으로 올려 가며 보낸다.
//   k6 run load/k6-limit.js                         (기본: http://localhost:5201)
//   k6 run --out csv=limit.csv load/k6-limit.js     (계단별로 나눠 보려면)
// 서버가 못 따라가면: 응답 시간이 치솟고, k6 가 제때 보내지 못한 반복(dropped_iterations)이 쌓인다.
import mixed, { setup as seed } from './k6-mixed.js';

const STEPS = (__ENV.STEPS || '1000,2000,3000,4000,6000,8000,11000,15000').split(',').map(Number);
const HOLD = __ENV.HOLD || '20s';

export const options = {
  scenarios: {
    limit: {
      executor: 'ramping-arrival-rate',
      startRate: STEPS[0],
      timeUnit: '1s',
      preAllocatedVUs: 400,
      maxVUs: 3000,
      stages: STEPS.flatMap((r) => [{ duration: '3s', target: r }, { duration: HOLD, target: r }]),
    },
  },
  thresholds: {
    // 완전히 무너지면(에러 30% 넘게) 멈춘다
    http_req_failed: [{ threshold: 'rate<0.3', abortOnFail: true, delayAbortEval: '10s' }],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export const setup = seed;
export default mixed;
