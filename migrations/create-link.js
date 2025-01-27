'use strict';
module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.createTable('Links', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      state: {
        type: Sequelize.STRING
      },
      creatorId: {
        type: Sequelize.INTEGER
      },
      type: {
        type: Sequelize.STRING
      },
      index: {
        type: Sequelize.INTEGER
      },
      relationship: {
        type: Sequelize.STRING
      },
      description: {
        type: Sequelize.TEXT
      },
      itemAId: {
        type: Sequelize.INTEGER
      },
      itemBId: {
        type: Sequelize.INTEGER
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },
  down: (queryInterface, Sequelize) => {
    return queryInterface.dropTable('Links');
  }
};