/**
 * @flow
 */

import cookie from 'cookie';

const SNACK_COOKIE_NAME = 'snack-values';
const choose = array => array[Math.floor(Math.random() * array.length)];
const chooseWithWeights = weights => {
  const random = Math.random();
  let runningWeight = 0;
  let value;
  for (value of Object.keys(weights)) {
    // $FlowIgnore
    runningWeight += weights[value];
    if (random <= runningWeight) {
      return value;
    }
  }
  return value;
};

// TODO: define a type for next contexts (see https://github.com/zeit/next.js/blob/master/readme.md#fetching-data-and-component-lifecycle)
export default async (ctx: any) => {
  let cookies = {};
  if (ctx.req.headers && ctx.req.headers.cookie) {
    /* $FlowIgnore */
    cookies = cookie.parse(ctx.req.headers.cookie || {});
  }
  const storedValues = cookies[SNACK_COOKIE_NAME];
  const isNewUser = !storedValues;
  const existingSettings = !isNewUser ? JSON.parse(storedValues) : {};

  // Users that we have already seen, but haven't tagged with first seen should not get today's date
  const userDetails = {
    snackFirstSeen: !isNewUser ? '2017-11-01' : new Date().toISOString().slice(0, 10), // 'YYYY-MM-DD'
  };

  const testSettings = {
    defaultPreviewPlatform: chooseWithWeights({ android: 0.1, ios: 0.9 }),
    defaultConnectionMethod: chooseWithWeights({
      'device-id': 0.5,
      'qr-code': 0.25,
      account: 0.25,
    }),
    authFlow: choose(['save1', 'save2']),
  };

  const newValues = {
    ...testSettings,
    ...userDetails,
    ...existingSettings,
  };

  ctx.res.setHeader('Set-Cookie', cookie.serialize(SNACK_COOKIE_NAME, JSON.stringify(newValues)));
  return newValues;
};
