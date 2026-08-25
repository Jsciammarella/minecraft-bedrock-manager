const path = require('path');

const pkg = require(path.join(__dirname, '../../package.json'));

const PRODUCT_NAME = 'minecraft-bedrock-manager';
const CONTACT_URL = 'https://github.com/Jsciammarella/minecraft-bedrock-manager';

function productVersion() {
  return String(pkg.version || '0.0.0');
}

function userAgent() {
  return `${PRODUCT_NAME}/${productVersion()} (${CONTACT_URL})`;
}

module.exports = {
  CONTACT_URL,
  PRODUCT_NAME,
  productVersion,
  userAgent,
};
