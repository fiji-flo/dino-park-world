import elasticsearch from "elasticsearch";
import connectionClass from "http-aws-es";

import { logger } from "./config";

const DOC_MAPPING = {
  _doc: {
    properties: {
      suggest: { type: "completion" },
      city: { type: "text" },
      region: { type: "text" },
      country: { type: "text" },
      population: { type: "long" }
    }
  }
};

function toDoc(city) {
  return {
    suggest: [
      {
        input: [
          `${city.city}`,
          `${city.city} ${city.country}`,
          `${city.city} ${city.region}`,
          `${city.city} ${city.region} ${city.country}`,
          `${city.country} ${city.city}`,
          `${city.country} ${city.region} ${city.city}`,
          `${city.region}`,
          `${city.region} ${city.city}`
        ],
        weight: city.population
      }
    ],
    ...city
  };
}

class Storage {
  constructor(cfg, esClient = elasticsearch.Client) {
    this.cfg = cfg;
    const options = {
      host: this.cfg.elasticHost
    };
    if (cfg.elasticAwsDefaultRegion !== "") {
      options.connectionClass = connectionClass;
    }
    this.client = new esClient(options);
    this.deleteConfirmationTimer = null;
    this.index = cfg.elasticIndex;
  }

  async init() {
    logger.info(`creating index: ${this.index}`);

    const exists = await this.client.indices.exists({ index: this.index });
    if (!exists) {
      await this.client.indices.create({
        index: this.index,
        body: { mappings: DOC_MAPPING }
      });
    }
    return this;
  }

  async bulkIndex(docs) {
    const bulk = docs.flatMap(doc => [
      { index: { _index: this.index, _type: "_doc" } },
      toDoc(doc)
    ]);
    return this.client.bulk({ body: bulk });
  }

  async suggest(term) {
    logger.info(`suggesting for: ${term}`);
    const suggestions = await this.client.search({
      index: this.index,
      type: "_doc",
      body: {
        suggest: {
          city_suggest: {
            prefix: term,
            completion: {
              field: "suggest"
            }
          }
        }
      }
    });
    const {
      suggest: {
        city_suggest: [{ options: cities } = { options: [] }]
      }
    } = suggestions;
    return cities.map(({ _source: { country, region, city } }) => {
      return { country, region, city };
    });
  }

  async recreateIndices() {
    if (this.deleteConfirmationTimer !== null) {
      clearTimeout(this.deleteConfirmationTimer);
      this.deleteConfirmationTimer = null;
      const params = {
        index: [this.index]
      };
      logger.info(`deleting ${JSON.stringify(params)}`);
      try {
        await this.client.indices.delete(params);
        await this.init();
      } catch (e) {
        logger.error(e);
      }
      return { recreate: "done" };
    } else {
      this.deleteConfirmationTimer = setTimeout(() => {
        logger.warn("recreation not confirmed");
        this.deleteConfirmationTimer = null;
      }, 2000);
      return { recreate: "confirm please" };
    }
  }
}

export { Storage as default };
