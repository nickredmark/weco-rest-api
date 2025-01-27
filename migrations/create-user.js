'use strict';
module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.createTable('Users', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      handle: {
        type: Sequelize.STRING
      },
      name: {
        type: Sequelize.STRING
      },
      email: {
        type: Sequelize.STRING
      },
      password: {
        type: Sequelize.STRING
      },
      bio: {
        type: Sequelize.TEXT
      },
      flagImagePath: {
        type: Sequelize.TEXT
      },
      coverImagePath: {
        type: Sequelize.TEXT
      },
      facebookId: {
        type: Sequelize.STRING
      },
      emailVerified: {
        type: Sequelize.BOOLEAN
      },
      emailToken: {
        type: Sequelize.TEXT
      },
      accountVerified: {
        type: Sequelize.BOOLEAN
      },
      passwordResetToken: {
        type: Sequelize.TEXT
      },
      state: {
        type: Sequelize.STRING
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
    return queryInterface.dropTable('Users');
  }
};