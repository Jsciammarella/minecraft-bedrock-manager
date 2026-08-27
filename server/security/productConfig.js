/**
 * Trusted product security identity.
 *
 * Edition packages may replace this file at build time. It is not a user
 * setting, is not stored in the database, and plugins cannot change it.
 *
 * securityProfile:
 *   null     – derive from the product version patch
 *              (.0/.3 no-auth, .6/.9 local-rbac; other suffixes are rejected)
 *   'no-auth' | 'local-rbac'
 */
module.exports = {
  securityProfile: null,
};
